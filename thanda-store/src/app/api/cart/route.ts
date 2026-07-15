import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentCatalogue } from '@/lib/catalogue';
import { currentUser } from '@/lib/auth/server';

async function cartResponse() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const rows = await pool.query('SELECT product_id, quantity FROM portal_cart_lines WHERE user_id = $1 ORDER BY created_at ASC', [user.id]);
  const products = await currentCatalogue(user.discounts);
  const byId = new Map(products.map((product) => [product.id, product]));
  const lines = rows.rows.flatMap((row) => {
    const product = byId.get(Number(row.product_id));
    return product ? [{ product, quantity: Number(row.quantity) }] : [];
  });
  return NextResponse.json({
    lines,
    itemCount: lines.reduce((total, line) => total + line.quantity, 0),
    subtotalExVat: lines.reduce((total, line) => total + (line.product.your_price_ex_vat || 0) * line.quantity, 0),
  });
}

function validQuantity(value: unknown) {
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 999 ? quantity : null;
}

export async function GET() {
  try { return await cartResponse(); } catch (error) {
    console.error('Cart GET error:', error);
    return NextResponse.json({ error: 'Unable to load cart' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const { productId, quantity = 1 } = await request.json();
    const id = Number(productId);
    const requested = validQuantity(quantity);
    if (!Number.isInteger(id) || !requested) return NextResponse.json({ error: 'A valid product and quantity are required' }, { status: 400 });
    const productResult = await pool.query(`
      SELECT supplier, stock_on_hand,
        NULLIF(details->>'localStockOnHand', '')::numeric AS local_stock_on_hand
      FROM products
      WHERE id = $1
        AND COALESCE((details->>'hidden')::boolean, false) = false
    `, [id]);
    if (!productResult.rowCount) return NextResponse.json({ error: 'Product is no longer available' }, { status: 404 });

    const product = productResult.rows[0];
    const supplier = String(product.supplier).toLowerCase();
    const isUnavailableSupplierItem = ['renogy', 'victron'].includes(supplier)
      && Number(product.stock_on_hand) <= 0
      && Number(product.local_stock_on_hand ?? 0) <= 0;
    if (isUnavailableSupplierItem) {
      return NextResponse.json({ error: 'This product is currently not available to order' }, { status: 409 });
    }
    await pool.query(`
      INSERT INTO portal_cart_lines (user_id, product_id, quantity)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, product_id)
      DO UPDATE SET quantity = LEAST(portal_cart_lines.quantity + EXCLUDED.quantity, 999), updated_at = NOW()
    `, [user.id, id, requested]);
    return cartResponse();
  } catch (error) {
    console.error('Cart POST error:', error);
    return NextResponse.json({ error: 'Unable to update cart' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const { productId, quantity } = await request.json();
    const id = Number(productId);
    const requested = validQuantity(quantity);
    if (!Number.isInteger(id) || !requested) return NextResponse.json({ error: 'A valid product and quantity are required' }, { status: 400 });
    await pool.query('UPDATE portal_cart_lines SET quantity = $3, updated_at = NOW() WHERE user_id = $1 AND product_id = $2', [user.id, id, requested]);
    return cartResponse();
  } catch (error) {
    console.error('Cart PATCH error:', error);
    return NextResponse.json({ error: 'Unable to update cart' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const id = Number(request.nextUrl.searchParams.get('productId'));
    if (!Number.isInteger(id)) return NextResponse.json({ error: 'A valid product is required' }, { status: 400 });
    await pool.query('DELETE FROM portal_cart_lines WHERE user_id = $1 AND product_id = $2', [user.id, id]);
    return cartResponse();
  } catch (error) {
    console.error('Cart DELETE error:', error);
    return NextResponse.json({ error: 'Unable to update cart' }, { status: 500 });
  }
}
