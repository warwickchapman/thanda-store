import requests
import pandas as pd
import time
import os

# Configuration captured from research
JWT_TOKEN = "eyJhbGciOiJIUzUxMiJ9.eyJ1c2VyX2lkIjoyNDM3ODIsImNsaWVudF9lbmRwb2ludCI6IndlYiIsImF1dGhfdG9rZW5faWQiOiJjMTc5OGYxYi1hZWVlLTRiZmQtYjBmMC03OTIwMTU2ZDVhZjAifQ.2XPJU1zIPlXhtWxLD0Yn5vxDQE3HsCyu5Ou_fXtmPC3qgmMlIwtE2UsRgk-LLxmAFwBUmclX2k6VTgR3l0Yvfg"
BASE_URL = "https://partner.renogy.com/prod-api/api/sc/portal"
HEADERS = {
    "Authorization": f"Bearer {JWT_TOKEN}",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://partner.renogy.com/product/batteries"
}

def fetch_product_details(item_id):
    """Fetches marketing names and images from the individual product detail API."""
    try:
        # Fixed endpoint based on testing
        url = f"{BASE_URL}/item/{item_id}"
        response = requests.get(url, headers=HEADERS)
        response.raise_for_status()
        
        # Deeply nested data structure in Renogy API
        raw_data = response.json().get("data") or {}
        inner_data = raw_data.get("data") or {}
        
        # Marketing name is in 'item_view_title', but fallback to 'description' or 'item_model' if null
        marketing_name = inner_data.get("item_view_title") or inner_data.get("description") or inner_data.get("item_model")
        image_url = ""
        
        # Images are in 'item_view_image' or 'item_cover_image'
        images = inner_data.get("item_view_image") or inner_data.get("item_cover_image") or []
        if images and isinstance(images, list):
            image_url = images[0].get("link") or images[0].get("url")
            
        return marketing_name, image_url
    except Exception as e:
        print(f"    Failed to fetch details for {item_id}: {e}")
        return None, None

def fetch_all_products():
    all_items = []
    # Expanded category list to ensure total warehouse coverage
    batches = [
        ["battery", "energy_storage_product"],
        ["solar-panel", "charge-controller"],
        ["inverter", "charger"],
        ["accessories", "portable-power-station"],
        ["dc-to-dc-charger", "smart-lithium-battery"],
        ["monitoring"],
        ["rv-power-system", "home-power-system"],
        ["new-arrival", "on-sale"]
    ]
    
    print("Starting deep-extraction of warehouse inventory with marketing details...")

    for batch in batches:
        page_num = 1
        page_size = 30
        print(f"\nScanning category: {batch}")

        while True:
            payload = {
                "itemViewType": batch,
                "pageNum": page_num,
                "pageSize": page_size,
                "isDiscount": False,
                "discountId": 77,
                "productSearch": "",
                "isMarketingSupport": False
            }

            try:
                response = requests.post(f"{BASE_URL}/item/listPage", headers=HEADERS, json=payload)
                response.raise_for_status()
                data_json = response.json()

                if data_json.get("code") != 200:
                    print(f"  API Alert ({data_json.get('code')}): {data_json.get('msg')}")
                    break

                data = data_json.get("data") or {}
                items = data.get("rows") or []
                total_count = data.get("total") or 0
                
                if not items:
                    break

                print(f"  Page {page_num}: Found {len(items)} items. Fetching rich details...")
                
                for item_wrapper in items:
                    item = item_wrapper.get("data") or {}
                    item_id = item_wrapper.get("id")
                    
                    # FETCH DEEP DETAILS (Marketing Name & Image)
                    m_name, m_image = fetch_product_details(item_id)
                    
                    combined_data = {
                        "SKU": item.get("id"),
                        "Product Name": m_name or item.get("name"),
                        "Image URL": m_image or "",
                        "Stock On Hand": item.get("inventory"),
                        "Safety Inventory": item.get("safety_inventory"),
                        "Available Overseas": item.get("available_overseas"),
                        "Dealer Price": item.get("amount"),
                        "Base Price": item.get("basic_price"),
                        "Original Price": item.get("originalPrice"),
                        "Category": item.get("item_view_type") or "-".join(batch),
                        "Product ID": item_id,
                        "Product URL": f"https://partner.renogy.com/product/item/{item_id}",
                        "Weight (kg)": item.get("product_shipping_weight_kg"),
                        "UPC": item.get("upc_code")
                    }
                    # Deduplicate by Product ID
                    if not any(d['Product ID'] == item_id for d in all_items):
                        all_items.append(combined_data)
                    
                    time.sleep(0.3) # Throttle detail fetches

                # Pagination check
                if len(all_items) >= total_count and total_count > 0:
                    break
                
                if len(items) < page_size:
                    break
                    
                page_num += 1
                time.sleep(1)

            except Exception as e:
                print(f"  Error scanning {batch} at page {page_num}: {e}")
                break

    return all_items

def export_data(items):
    if not items:
        print("No inventory found.")
        return

    df = pd.DataFrame(items)
    
    # Ensure local directory exists
    csv_file = "renogy_products.csv"
    df.to_csv(csv_file, index=False)
    print(f"Inventory saved to {csv_file}")

    excel_file = "renogy_products.xlsx"
    df.to_excel(excel_file, index=False)
    print(f"Inventory saved to {excel_file}")

if __name__ == "__main__":
    products = fetch_all_products()
    export_data(products)
    print(f"\nDeep-scrape complete. Total unique warehouse products identified: {len(products)}")
