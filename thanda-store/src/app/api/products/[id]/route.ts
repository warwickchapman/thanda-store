import { currentUser } from '@/lib/auth/server';
import pool from '@/lib/db';
import { productDetails } from '@/lib/product-details.mjs';
import { isStorefrontProduct } from '@/lib/catalogue-classification.mjs';
export async function GET(_request: Request,{params}:{params:Promise<{id:string}>}) {
  const user=await currentUser();
  if(!user)return Response.json({error:'Sign in required.'},{status:401});
  const id=Number((await params).id);
  if(!Number.isSafeInteger(id)||id<1)return Response.json({error:'Product not found.'},{status:404});
  const {rows}=await pool.query("SELECT id,supplier,name,category,details FROM products WHERE id=$1 AND COALESCE((details->>'hidden')::boolean,false)=false",[id]);
  const product=rows[0];
  if(!product||!isStorefrontProduct(product))return Response.json({error:'Product not found.'},{status:404});
  return Response.json(productDetails(product),{headers:{'Cache-Control':'private, no-cache'}});
}
