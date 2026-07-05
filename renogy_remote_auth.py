import asyncio
import json
import os
import sys
from playwright.async_api import async_playwright

# Configuration
PORTAL_URL = "https://partner.renogy.com/product/solar-panel"
SCRAPER_PATH = "/root/renogy-store/renogy_scraper.py"

async def refresh_token():
    print("Starting headless browser to capture Renogy token...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        )
        page = await context.new_page()

        token = None

        # Listen for requests to capture the Authorization header
        async def handle_request(request):
            nonlocal token
            if "Authorization" in request.headers:
                auth = request.headers["Authorization"]
                if auth.startswith("eyJ"): # Likely JWT
                    token = auth
                    # print(f"Captured Token: {token[:20]}...")

        page.on("request", handle_request)

        try:
            # Navigate to the portal
            await page.goto(PORTAL_URL, wait_until="domcontentloaded", timeout=60000)
            
            # Wait a bit for background requests
            await asyncio.sleep(10)

            if token:
                print("Successfully captured token!")
                update_scraper_token(token)
                return True
            else:
                print("Failed to capture token. May need manual login/cookie injection.")
                return False

        except Exception as e:
            print(f"Error during token capture: {e}")
            return False
        finally:
            await browser.close()

def update_scraper_token(new_token):
    if not os.path.exists(SCRAPER_PATH):
        print(f"Scraper not found at {SCRAPER_PATH}")
        return

    with open(SCRAPER_PATH, 'r') as f:
        content = f.read()

    # Simple string replacement for the token variable
    # Assuming the scraper has a line like: JWT_TOKEN = "..."
    import re
    new_content = re.sub(r'JWT_TOKEN\s*=\s*".*?"', f'JWT_TOKEN = "{new_token}"', content)
    
    if new_content != content:
        with open(SCRAPER_PATH, 'w') as f:
            f.write(new_content)
        print("Scraper updated with fresh token.")
    else:
        print("Could not find TOKEN variable in scraper file.")

if __name__ == "__main__":
    success = asyncio.run(refresh_token())
    if not success:
        sys.exit(1)
