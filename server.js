require('dotenv').config();
const { chromium } = require('playwright');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configurations for each platform
const CONFIG = {
    trendyol: {
        url: 'https://www.trendyol.com/sr?wc=103328&fl=en-cok-one-cikanlar',
        selector: '.product-card-jfy',
        parser: null // Logic is inside scrape function
    },
    // Add other platforms like Temu here in future...
    temu: {
        url: 'https://www.temu.com/az/channel/lightning-deals.html',
        selector: '.goods-item',
        parser: null
    }
};

async function scrape(platformKey) {
    if (!CONFIG[platformKey]) return { error: 'Platform not supported' };

    const config = CONFIG[platformKey];
    console.log(`Starting scrape for ${platformKey}...`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        extraHTTPHeaders: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        }
    });

    // Force Region to Azerbaijan (AZN) to match local environment and ensure consistent CSS
    await context.addCookies([
        { name: 'countryCode', value: 'AZ', domain: '.trendyol.com', path: '/' },
        { name: 'currency', value: 'AZN', domain: '.trendyol.com', path: '/' },
        { name: 'storefrontId', value: '34', domain: '.trendyol.com', path: '/' } // 34 is often AZ/Intl
    ]);

    const page = await context.newPage();

    try {
        await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Random scroll to trigger lazy loading
        await page.evaluate(async () => {
            window.scrollBy(0, window.innerHeight);
        });
        await page.waitForTimeout(3000);

        // Extract Data
        const products = await page.evaluate(({ selector }) => {
            const items = [];
            document.querySelectorAll(selector).forEach(el => {
                const getTxt = (sel) => el.querySelector(sel) ? el.querySelector(sel).innerText : '';

                // New Selectors with fallbacks for Mobile/Desktop differences:
                const brand = getTxt('.product-brand') || getTxt('.prdct-desc-cntnr-ttl');
                const name = getTxt('.product-name') || getTxt('.prdct-desc-cntnr-name') || getTxt('.fn.name');

                // Strategy 1: Specific Selectors
                let price = getTxt('.sale-price') || getTxt('.prc-box-dscntd') || getTxt('.prc-box-sllng') || getTxt('.discounted-price');
                let orgPrice = getTxt('.strikethrough-price') || getTxt('.prc-box-orgnl') || getTxt('.original-price');

                // Strategy 2: Regex on the whole card text if price is missing
                if (!price) {
                    const text = el.innerText;
                    // Look for price patterns like "123,45 TL", "123.45 ₼"
                    // Capture the last price mentioned as likely the sale price
                    const priceMatch = text.match(/([0-9.,]+)\s*(?:TL|₼|AZN)/gi);
                    if (priceMatch && priceMatch.length > 0) {
                        price = priceMatch[0]; // Take first match as price (risky but better than nothing)
                        // If there are two prices, usually first is sale, second is original? No, usually original struckthrough is first.
                        // Actually in text flow: "Original: 100 - Sale: 80".
                        if (priceMatch.length > 1) {
                            orgPrice = priceMatch[0]; // Expecting regex to find org first
                            price = priceMatch[priceMatch.length - 1]; // Sale price last
                        }
                    }
                }

                if (!orgPrice) orgPrice = price;

                const link = el.getAttribute('href') || (el.querySelector('a') ? el.querySelector('a').href : '');
                const img = el.querySelector('img') ? el.querySelector('img').src : '';

                items.push({
                    title: (brand + ' ' + name).trim(),
                    priceStr: price,
                    orgPriceStr: orgPrice,
                    link: link.startsWith('http') ? link : 'https://www.trendyol.com' + link, // Fix relative links
                    img: img
                });
            });
            return items;
        }, { selector: config.selector });

        // Process Data & Filter in Node
        const validProducts = products.map(p => {
            const parseTRPrice = (str) => {
                if (!str) return 0;
                // Remove currency symbols (TL, ₼, etc) and spaces
                const clean = str.replace(/[^0-9,.]/g, '')
                    .replace(/\./g, '') // Remove dots (thousands separator in TR)
                    .replace(',', '.'); // Replace comma with dot (decimal separator in TR)
                return parseFloat(clean);
            };

            // Trendyol AZ/TR price formats can vary. 
            // "28,07 ₼" -> 28.07
            // "1.200 TL" -> 1200
            // Robust parsing:
            const cleanAndParse = (str) => {
                if (!str) return 0;
                // Check if dot or comma is the decimal separator
                // Usually last punctuation is decimal if followed by 2 digits
                // But simplified: Remove non-digits/dots/commas
                let s = str.replace(/[^0-9,.]/g, '');
                if (s.includes(',') && s.includes('.')) {
                    // 1.250,50 
                    s = s.replace(/\./g, '').replace(',', '.');
                } else if (s.includes(',')) {
                    s = s.replace(',', '.');
                }
                return parseFloat(s);
            };

            const price = cleanAndParse(p.priceStr);
            let orgPrice = cleanAndParse(p.orgPriceStr);
            if (orgPrice === 0) orgPrice = price;

            let discount = 0;
            if (orgPrice > price && orgPrice > 0) {
                discount = ((orgPrice - price) / orgPrice) * 100;
            }

            return {
                title: p.title,
                price,
                original_price: orgPrice,
                discount_rate: Math.round(discount),
                image_url: p.img,
                product_url: p.product_url || p.link,
                platform: platformKey,
                external_id: p.link // Simple unique ID
            };
        }).filter(p => p.discount_rate >= 40 && p.price > 0);

        console.log(`Found ${products.length} items, ${validProducts.length} matched >40% discount.`);

        // Save to Supabase
        const savedItems = [];
        for (const prod of validProducts) {
            const { data, error } = await supabase
                .schema('public')
                .from('products')
                .upsert(prod, { onConflict: 'platform, external_id', ignoreDuplicates: true })
                .select();

            if (!error && data) savedItems.push(data[0]);
            else if (error) console.error('Supabase Error details:', error);
        }

        return {
            status: 'success',
            total_found: products.length,
            filtered_count: validProducts.length,
            saved_count: savedItems.length,
            data: validProducts.slice(0, 50),
            debug_raw_data: products.slice(0, 10) // DEBUG: Show what was actually found
        };

    } catch (e) {
        console.error(e);
        return { error: e.message };
    } finally {
        await browser.close();
    }
}

app.get('/scrape/:platform', async (req, res) => {
    const result = await scrape(req.params.platform);
    res.json(result);
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
});