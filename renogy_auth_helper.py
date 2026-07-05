import asyncio
import websockets
import json

# This script sniffs a running Chrome instance to extract the latest Renogy JWT token.
# It prints an export command so the token can be stored outside tracked source.

WS_LIST_URL = "http://localhost:9222/json/list"

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

async def main():
    ws_url = await get_renogy_tab()
    if not ws_url:
        print("Renogy tab not found in Chrome. Please open it in the debugger-enabled Chrome instance.")
        return

    token = await capture_token(ws_url)
    if token:
        print("Add this to your environment file:")
        print(f"RENOGY_BEARER_TOKEN={token}")
    else:
        print("Failed to capture token.")

if __name__ == "__main__":
    asyncio.run(main())
