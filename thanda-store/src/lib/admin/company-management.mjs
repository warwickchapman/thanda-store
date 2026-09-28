// Admin reads only the Hub's stored contact snapshot via getContact. No Xero calls,
// sync commands, polling or retries. At most one stored contact read per edit.
export function defaultCompanyDiscount() {
  const configured = Number(process.env.DEFAULT_B2B_DISCOUNT_PERCENT);
  return Math.max(0, Math.min(40, Number.isFinite(configured) ? configured : 30));
}

export class CompanyManagementError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function eligiblePerson(contact, email) {
  const person = contact.people.find((candidate) => candidate.email.toLowerCase() === email);
  if (!person) throw new CompanyManagementError('This email is not an eligible person on the selected company’s Xero contact. Update the contact in Xero and wait for its stored snapshot to refresh, or select the correct company.');
  return person;
}

async function transaction(pool, work) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    if (error.code === '23505') throw new CompanyManagementError('That email or Xero company already exists.', 409);
    throw error;
  } finally { db.release(); }
}

async function revokePersonCredentials(db, userId) {
  await db.query('DELETE FROM portal_sessions WHERE user_id=$1', [userId]);
  await db.query('UPDATE login_otps SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [userId]);
  await db.query('UPDATE account_setup_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [userId]);
  await db.query('UPDATE portal_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1', [userId]);
}

async function audit(db, actor, action, resourceType, resourceId, metadata) {
  await db.query(`INSERT INTO portal_activity_log(user_id,organisation_id,action,resource_type,resource_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [actor.id, actor.organisationId, action, resourceType, String(resourceId), JSON.stringify(metadata)]);
}

export async function updateUserEmail(pool, { userId, email, actor, getContact }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!Number.isSafeInteger(userId) || userId < 1 || !/^\S+@\S+\.\S+$/.test(normalized)) throw new CompanyManagementError('A valid user and email address are required.');
  return transaction(pool, async (db) => {
    const result = await db.query(`SELECT u.email,u.role,u.organisation_id,o.xero_contact_id FROM portal_users u
      JOIN organisations o ON o.id=u.organisation_id WHERE u.id=$1 FOR UPDATE OF u,o`, [userId]);
    const user = result.rows[0];
    if (!user) throw new CompanyManagementError('User not found.', 404);
    if (user.email.toLowerCase() === normalized) return { unchanged: true, signedOut: false };
    const duplicate = await db.query('SELECT id FROM portal_users WHERE LOWER(email)=$1 AND id<>$2', [normalized, userId]);
    if (duplicate.rowCount) throw new CompanyManagementError('That email address is already assigned to another portal user.', 409);
    if (!user.xero_contact_id && user.role !== 'admin') throw new CompanyManagementError('Move this user to a linked company before changing their email.');
    const person = user.xero_contact_id ? eligiblePerson(await getContact(user.xero_contact_id), normalized) : null;
    await db.query(`UPDATE portal_users SET email=$2,xero_person_kind=$3,xero_person_email=$4,updated_at=now() WHERE id=$1`,
      [userId, normalized, person?.kind || 'manual', person?.email || null]);
    await revokePersonCredentials(db, userId);
    await audit(db, actor, 'user_email_changed', 'user', userId, { from: user.email, to: normalized, organisationId: user.organisation_id });
    return { signedOut: userId === actor.id };
  });
}

export async function moveUserCompany(pool, { userId, organisationId, email, actor, getContact }) {
  if (![userId, organisationId].every((id) => Number.isSafeInteger(id) && id > 0)) throw new CompanyManagementError('Select a user and destination company.');
  return transaction(pool, async (db) => {
    const result = await db.query('SELECT email,role,organisation_id FROM portal_users WHERE id=$1 FOR UPDATE', [userId]);
    const user = result.rows[0];
    if (!user) throw new CompanyManagementError('User not found.', 404);
    const destinationEmail = String(email ?? user.email).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(destinationEmail)) throw new CompanyManagementError('Provide a valid email at the destination company.');
    if (Number(user.organisation_id) === organisationId) {
      if (destinationEmail !== user.email.toLowerCase()) throw new CompanyManagementError('Use Update email to change an email within the same company.');
      return { unchanged: true, signedOut: false };
    }
    const duplicate = await db.query('SELECT id FROM portal_users WHERE LOWER(email)=$1 AND id<>$2', [destinationEmail, userId]);
    if (duplicate.rowCount) throw new CompanyManagementError('That email address is already assigned to another portal user.', 409);
    const company = (await db.query('SELECT id,xero_contact_id FROM organisations WHERE id=$1 FOR UPDATE', [organisationId])).rows[0];
    if (!company) throw new CompanyManagementError('Company not found.', 404);
    if (!company.xero_contact_id && user.role !== 'admin') throw new CompanyManagementError('Buyers must belong to a company linked to Xero.');
    const person = company.xero_contact_id ? eligiblePerson(await getContact(company.xero_contact_id), destinationEmail) : null;
    await db.query(`UPDATE portal_users SET organisation_id=$2,xero_person_kind=$3,xero_person_email=$4,
      api_enabled=false,email=$5,updated_at=now() WHERE id=$1`, [userId, organisationId, person?.kind || 'manual', person?.email || null, destinationEmail]);
    await revokePersonCredentials(db, userId);
    await db.query('DELETE FROM portal_cart_lines WHERE user_id=$1', [userId]);
    await audit(db, actor, 'user_company_changed', 'user', userId, { from: user.organisation_id, to: organisationId, fromEmail: user.email, toEmail: destinationEmail });
    return { signedOut: userId === actor.id };
  });
}

function validateDiscounts(victron, renogy) {
  if (![victron, renogy].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 40)) {
    throw new CompanyManagementError('Victron and Renogy discounts must be between 0% and 40%.');
  }
}

export async function saveCompanyDiscounts(pool, { organisationId, victron, renogy, actor }) {
  validateDiscounts(victron, renogy);
  if (!Number.isSafeInteger(organisationId) || organisationId < 1) throw new CompanyManagementError('Select a company.');
  return transaction(pool, async (db) => {
    const company = (await db.query('SELECT xero_contact_id FROM organisations WHERE id=$1 FOR UPDATE', [organisationId])).rows[0];
    if (!company?.xero_contact_id) throw new CompanyManagementError('Linked company not found.', 404);
    await db.query(`INSERT INTO contact_supplier_discounts(contact_id,supplier,discount_percent)
      VALUES($1,'victron',$2),($1,'renogy',$3) ON CONFLICT(contact_id,supplier)
      DO UPDATE SET discount_percent=EXCLUDED.discount_percent,updated_at=now()`, [company.xero_contact_id, victron, renogy]);
    await audit(db, actor, 'company_discounts_changed', 'xero_contact', company.xero_contact_id, { victron, renogy });
  });
}

export async function createCompany(pool, { contactId, victron, renogy, actor, getContact, primaryUser }) {
  validateDiscounts(victron, renogy);
  if (!String(contactId || '').trim()) throw new CompanyManagementError('Select a Xero contact.');
  const contact = await getContact(contactId);
  if (primaryUser) {
    const primary = contact.people.find((person) => person.kind === 'primary');
    if (!primary?.email || primary.email.toLowerCase() !== primaryUser.email) {
      throw new CompanyManagementError('The selected Xero contact needs a primary email before the company can be added.');
    }
  }
  return transaction(pool, async (db) => {
    const existing = await db.query('SELECT id FROM organisations WHERE xero_contact_id=$1', [contactId]);
    if (existing.rowCount) throw new CompanyManagementError('This Xero contact already has a company record. Open that company to manage its users or pricing.', 409);
    const company = (await db.query(`INSERT INTO organisations(name,xero_contact_id,xero_contact_name)
      VALUES($1,$2,$1) RETURNING id`, [contact.name, contactId])).rows[0];
    await db.query(`INSERT INTO contact_supplier_discounts(contact_id,supplier,discount_percent)
      VALUES($1,'victron',$2),($1,'renogy',$3) ON CONFLICT DO NOTHING`, [contactId, victron, renogy]);
    if (primaryUser) {
      company.primaryUser = (await db.query(`INSERT INTO portal_users
        (organisation_id,email,password_hash,role,is_active,xero_person_kind,xero_person_email)
        VALUES($1,$2,$3,'buyer',true,'primary',$2) RETURNING id,email,organisation_id`,
      [company.id, primaryUser.email, primaryUser.passwordHash])).rows[0];
    }
    await audit(db, actor, 'company_created', 'organisation', company.id,
      { contactId, primaryUserId: company.primaryUser?.id ?? null });
    return company;
  });
}
