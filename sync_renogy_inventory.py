import pandas as pd
import json
import requests
import time
import os
import sys

BASE_URL = "https://partner.renogy.com/prod-api/api/sc/portal"
JWT_TOKEN = os.environ.get("RENOGY_BEARER_TOKEN")
if not JWT_TOKEN:
    raise RuntimeError("RENOGY_BEARER_TOKEN is required")

HEADERS = {
    "Authorization": f"Bearer {JWT_TOKEN}",
    "Content-Type": "application/json"
}

def fetch_by_id(item_id):
    try:
        detail_url = f"{BASE_URL}/item/{item_id}"
        dr = requests.get(detail_url, headers=HEADERS)
        if dr.status_code == 200:
            res_json = dr.json()
            data_obj = res_json.get("data", {})
            inner = data_obj.get("data", {})
            
            image_url = ""
            if data_obj.get("item_cover_image"):
                image_url = data_obj.get("item_cover_image")
            elif inner.get("item_view_image"):
                image_url = inner.get("item_view_image")[0].get("url")
            
            return {
                "sku": inner.get("id") or inner.get("name"),
                "name": inner.get("item_view_title") or inner.get("description") or inner.get("name"),
                "price": inner.get("unitPrice") or 0,
                "originalPrice": inner.get("originalPrice") or 0,
                "image_url": image_url,
                "category": inner.get("item_view_type") or "accessories"
            }
    except Exception as e:
        pass
    return None

all_products = []
print("Starting Brute-Force ID Sync...", flush=True)

# We know IDs are hashes like '683405409a496b7d9ce33096'
# But maybe we can find more by trying different methods if we had them.
# Since we don't have the IDs, I'll try to find a way to get them.

# WAIT - If I can't search, maybe I can find the IDs in the browser network tab?
# The user's screenshot shows the URL contains the ID: 683405409a496b7d9ce33096
# I will try to fetch some known IDs and see if they work.

KNOWN_IDS = [
    "683405409a496b7d9ce33096", # Super Slim
    "685a6af1410b4e5ff2545c48", # Another one
]

for item_id in KNOWN_IDS:
    details = fetch_by_id(item_id)
    if details:
        print(f"Found: {details['sku']} - {details['name']}", flush=True)
        all_products.append(details)

# This is still not enough for 95 items.
