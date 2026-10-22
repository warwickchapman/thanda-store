import { currentUser } from '@/lib/auth/server';
import pool from '@/lib/db';
import { productDetails } from '@/lib/product-details.mjs';
import { isStorefrontProduct } from '@/lib/catalogue-classification.mjs';
import { loadSkuSuccessions } from '@/lib/sku-successions.mjs';
import { withSuccessionDetails } from '@/lib/catalogue-succession.mjs';
import { isProductVisibleTo } from '@/lib/catalogue-access.mjs';
export async function GET(_request: Request,{params}:{params:Promise<{id:string}>}) {
  const user=await currentUser();
  if(!user)return Response.json({error:'Sign in required.'},{status:401});
  const id=Number((await params).id);
  if(!Number.isSafeInteger(id)||id<1)return Response.json({error:'Product not found.'},{status:404});
  const {rows}=await pool.query("SELECT id,sku,supplier,name,category,details FROM products WHERE id=$1 AND COALESCE((details->>'hidden')::boolean,false)=false",[id]);
  const product=rows[0];
  if(!product||!isProductVisibleTo(product,user.email)||!isStorefrontProduct(product))return Response.json({error:'Product not found.'},{status:404});
  return Response.json(productDetails(withSuccessionDetails(product, await loadSkuSuccessions(pool))),{headers:{'Cache-Control':'private, no-cache'}});
}
