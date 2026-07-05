import asyncio
import websockets
import json
import os
import re

# This script sniffs a running Chrome instance to extract the latest Renogy JWT token.
# It then updates the renogy_scraper.py file with the new token.

WS_LIST_URL = "http://localhost:9222/json/list"
SCRAPER_FILE = "/Users/warwick/Code/renogy-store/renogy_scraper.py"

async def get_renogy_tab():
    import requests
    try:
        resp = requests.get(WS_LIST_URL)
        tabs = resp.json()
        for tab in tabs:
            if "partner.renogy.com" in tab.get("url", ""):
                return tab.get("webSocketDebuggerUrl")
    except Exception as e:
        print(f"Error listing tabs: {e}")
    return None

async def capture_token(ws_url):
    print(f"Connecting to Chrome tab: {ws_url}")
    async with websockets.connect(ws_url) as websocket:
        await websocket.send(json.dumps({
            "id": 1,
            "method": "Network.enable"
        }))
        
        # Trigger a refresh or navigation to ensure requests are sent if necessary,
        # but usually we can just wait for one if the page is active.
        # Alternatively, we can force a page reload:
        await websocket.send(json.dumps({
            "id": 2,
            "method": "Page.reload"
        }))

        print("Page reloaded. Waiting for Authorization header...")

        while True:
            message = await websocket.recv()
            data = json.loads(message)
            
            if data.get("method") == "Network.requestWillBeSent":
                headers = data["params"]["request"].get("headers", {})
                auth = headers.get("Authorization") or headers.get("authorization")
                if auth and auth.startswith("Bearer "):
                    token = auth.replace("Bearer ", "").strip()
                    print(f"Found Token: {token[:20]}...")
                    return token

def update_scraper(token):
    if not os.path.exists(SCRAPER_FILE):
        print(f"Scraper file not found: {SCRAPER_FILE}")
        return

    with open(SCRAPER_FILE, "r") as f:
        content = f.read()

    # Regex to replace JWT_TOKEN = "..."
    new_content = re.sub(r'JWT_TOKEN = "[^"]+"', f'JWT_TOKEN = "{token}"', content)

    with open(SCRAPER_FILE, "w") as f:
        f.write(new_content)
    print("renogy_scraper.py updated with new token.")

async def main():
    ws_url = await get_renogy_tab()
    if not ws_url:
        print("Renogy tab not found in Chrome. Please open it in the debugger-enabled Chrome instance.")
        return

    token = await capture_token(ws_url)
    if token:
        update_scraper(token)
    else:
        print("Failed to capture token.")

if __name__ == "__main__":
    asyncio.run(main())
