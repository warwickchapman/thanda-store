import { assertHubSnapshot } from './xero/hub.mjs';
import { companies, ensureReviewSchema, reviewCatalogue, advanceHistory, changeSignature, readReviewDecisions } from './victron-catalogue-review.mjs';

export async function catalogueHub(company, path, init = {}) {
  if (!companies.includes(company)) throw new Error('Unknown Xero company');
  const token = process.env.XERO_CATALOGUE_HUB_TOKEN;
  const base = process.env.XERO_HUB_URL;
  if (!token || !base) throw new Error('Configure the dedicated two-company catalogue Hub identity.');
  return fetch(`${base.replace(/\/$/, '')}/v1/${company}/${path}`, {
    ...init, cache: 'no-store', signal: AbortSignal.timeout(75000),
    headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token}` },
  });
}
export async function readItems(company, request = catalogueHub) {
  let snapshot;
  const items = [];
  for (let page = 1; page <= 50; page++) {
    const response = await request(company, `accounting/Items?page=${page}&pageSize=1000`, { headers: snapshot ? { 'X-Hub-Snapshot': snapshot } : {} });
    if (!response.ok) throw new Error(`${company}: saved Xero items unavailable (${response.status}).`);
    const body = await response.json();
    snapshot = assertHubSnapshot(body, snapshot);
    const age = Date.now() - Date.parse(body._hub.observed_at);
    if (body._hub.company !== company || body._hub.last_error || !Number.isFinite(age) || age < -300000 || age > 86400000 || !Array.isArray(body.Items)) throw new Error(`${company}: Xero item evidence is stale or incomplete.`);
    items.push(...body.Items);
    if (body.Items.length < 1000) return items;
  }
  throw new Error('Saved Xero item collection exceeds the bounded review limit.');
}
export async function refreshReview(pool, request = catalogueHub) {
  const db = await pool.connect();
  let locked = false;
  try {
    await ensureReviewSchema(db);
    locked = (await db.query("SELECT pg_try_advisory_lock(hashtext('victron-catalogue-review')) AS locked")).rows[0].locked;
    if (!locked) throw new Error('Another catalogue review is running.');
    const evidence = (await db.query('SELECT * FROM victron_catalogue_evidence WHERE id=true')).rows[0];
    if (!evidence) throw new Error('Wait for a complete supplier catalogue sync.');
    const state = (await db.query('SELECT * FROM victron_catalogue_review WHERE id=true')).rows[0];
    const successions = (await db.query('SELECT predecessor_sku,successor_sku FROM victron_sku_successions')).rows;
    const decisions = await readReviewDecisions(db);
    const items = {};
    for (const company of companies) items[company] = await readItems(company, request);
    const observedAt = new Date(evidence.observed_at).toISOString();
    // Count supplier observation dates, not job attempts, in the business timezone.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date(observedAt));
    const prior = { ...state.history };
    for (const company of companies) for (const item of items[company]) {
      if (/\bVictron\b/i.test(`${item.Name} ${item.Description} ${item.PurchaseDescription}`) && !prior[item.Code]) prior[item.Code] = { day: null, absentDays: 0 };
    }
    const history = advanceHistory(prior, evidence.products, day, successions, observedAt);
    let rows = reviewCatalogue({ catalogue: evidence.products, items, successions, history, decisions, observedAt });
    const completed = (await db.query("SELECT company,sku,max(created_at) AS completed_at FROM victron_catalogue_events WHERE action='archive-reviewed' GROUP BY company,sku")).rows;
    rows = rows.filter(row => row.kind !== 'archive' || !completed.some(event => event.company === row.company && event.sku === row.sku && (history[row.sku]?.absentSince || history[row.sku]?.retiredSince) && new Date(event.completed_at).getTime() >= Date.parse(history[row.sku].absentSince || history[row.sku].retiredSince)));
    const signature = changeSignature(rows);
    // Acknowledgement belongs to an uninterrupted change set. In particular, a
    // review SKU returning to stock must alert again after its silenced period.
    await db.query(`UPDATE victron_catalogue_review SET checked_at=now(),observed_at=$1,rows=$2,history=$3,
      history_day=$4,error=NULL,signature=$5,
      acknowledged_signature=CASE WHEN signature IS DISTINCT FROM $5 THEN NULL ELSE acknowledged_signature END
      WHERE id=true`, [observedAt, JSON.stringify(rows), JSON.stringify(history), day, signature]);
    return { rows, observedAt, signature };
  } catch (error) {
    if (locked) await db.query('UPDATE victron_catalogue_review SET checked_at=now(),error=$1,signature=$2 WHERE id=true', [error.message, changeSignature([], error.message)]);
    throw error;
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('victron-catalogue-review'))");
    db.release();
  }
}
