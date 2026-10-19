// Renogy does not publish Victron's explicit replacement markers. Administrators
// record confirmed replacements here; stock, prices and history remain per SKU.
export class RenogySkuSuccessionInputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const normaliseSku = value => typeof value === 'string' ? value.trim().toUpperCase() : '';

function skuPair(input) {
  const predecessorSku = normaliseSku(input?.predecessorSku);
  const successorSku = normaliseSku(input?.successorSku);
  if (![predecessorSku, successorSku].every(sku => /^[A-Z0-9][A-Z0-9._-]{1,149}$/.test(sku)) || predecessorSku === successorSku) {
    throw new RenogySkuSuccessionInputError('Choose two different Renogy SKUs from the saved catalogue.');
  }
  return { predecessorSku, successorSku };
}

export async function ensureRenogySkuSuccessionSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS renogy_sku_successions (
    predecessor_sku TEXT PRIMARY KEY,
    successor_sku TEXT NOT NULL,
    source_description TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (predecessor_sku <> successor_sku)
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS renogy_sku_successions_successor_idx ON renogy_sku_successions (successor_sku)');
}

export async function listRenogySkuSuccessions(db) {
  await ensureRenogySkuSuccessionSchema(db);
  const [products, successions] = await Promise.all([
    db.query(`SELECT sku, name, COALESCE(details->>'hidden' = 'true', false) AS hidden
      FROM products WHERE supplier = 'renogy' ORDER BY sku`),
    db.query(`SELECT predecessor_sku AS "predecessorSku", successor_sku AS "successorSku",
      source_description AS "sourceDescription", first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt"
      FROM renogy_sku_successions ORDER BY predecessor_sku`),
  ]);
  return { products: products.rows, successions: successions.rows };
}

async function changeSuccession(pool, operation) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Save and remove share the lock, so concurrent changes cannot create cycles
    // or silently replace an administrator's saved successor.
    await db.query('SELECT pg_advisory_xact_lock(742043)');
    await ensureRenogySkuSuccessionSchema(db);
    const result = await operation(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

export async function saveRenogySkuSuccession(pool, input) {
  const { predecessorSku, successorSku } = skuPair(input);
  const sourceDescription = String(input.sourceDescription || 'Manual entry by administrator').trim();
  if (!sourceDescription || sourceDescription.length > 1000) throw new RenogySkuSuccessionInputError('Replacement evidence must be at most 1,000 characters.');
  return changeSuccession(pool, async db => {
    const products = await db.query(`SELECT UPPER(sku) AS sku, COALESCE(details->>'hidden' = 'true', false) AS hidden
      FROM products WHERE supplier = 'renogy' AND UPPER(sku) = ANY($1::text[]) FOR SHARE`, [[predecessorSku, successorSku]]);
    if (products.rows.filter(product => product.sku === predecessorSku).length !== 1 || products.rows.filter(product => product.sku === successorSku).length !== 1) {
      throw new RenogySkuSuccessionInputError('Both SKUs must identify products in the saved Renogy catalogue.');
    }
    if (products.rows.find(product => product.sku === successorSku).hidden) {
      throw new RenogySkuSuccessionInputError('The replacement must be a current, visible Renogy catalogue product.');
    }
    const existing = await db.query('SELECT successor_sku FROM renogy_sku_successions WHERE predecessor_sku = $1', [predecessorSku]);
    if (existing.rowCount && existing.rows[0].successor_sku !== successorSku) {
      throw new RenogySkuSuccessionInputError(`${predecessorSku} already points to ${existing.rows[0].successor_sku}. Remove that link before choosing another replacement.`, 409);
    }
    const cycle = await db.query(`WITH RECURSIVE successors(sku) AS (
      SELECT $1::text
      UNION
      SELECT s.successor_sku FROM renogy_sku_successions s JOIN successors c ON s.predecessor_sku = c.sku
    ) SELECT 1 FROM successors WHERE sku = $2`, [successorSku, predecessorSku]);
    if (cycle.rowCount) throw new RenogySkuSuccessionInputError('This link would create a replacement cycle. Check the existing links first.', 409);
    await db.query(`INSERT INTO renogy_sku_successions (predecessor_sku, successor_sku, source_description)
      VALUES ($1, $2, $3) ON CONFLICT (predecessor_sku) DO UPDATE SET last_seen_at = NOW()`,
    [predecessorSku, successorSku, sourceDescription]);
    return { predecessorSku, successorSku };
  });
}

export async function removeRenogySkuSuccession(pool, input) {
  const { predecessorSku, successorSku } = skuPair(input);
  return changeSuccession(pool, async db => {
    const result = await db.query('DELETE FROM renogy_sku_successions WHERE predecessor_sku = $1 AND successor_sku = $2', [predecessorSku, successorSku]);
    if (!result.rowCount) throw new RenogySkuSuccessionInputError('That replacement link no longer exists. Refresh the list.', 404);
    return { predecessorSku, successorSku };
  });
}
