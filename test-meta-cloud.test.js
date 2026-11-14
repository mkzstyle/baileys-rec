import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fromCloudApiMessage,
    toCloudApiMessage,
    sanitizeWhatsAppNumber,
    diagnoseMetaCloudApiError,
    ButtonBuilder,
    MessageBuilder,
    serializeMessage
} from './lib/Utils/cloud-api-utils.js';
import {
    generateWAMessageContent,
    shouldIncludeBizBinaryNode
} from './lib/Utils/messages.js';

test('sanitizeWhatsAppNumber removes symbols, whatsapp suffix and normalizes national prefix', () => {
    assert.equal(sanitizeWhatsAppNumber('+62 812-3456-7890'), '6281234567890');
    assert.equal(sanitizeWhatsAppNumber('6281234567890@s.whatsapp.net'), '6281234567890');
    assert.equal(sanitizeWhatsAppNumber('081234567890'), '6281234567890');
    assert.equal(sanitizeWhatsAppNumber('14155552671'), '14155552671');
});

test('fromCloudApiMessage converts text and preview_url properly', () => {
    const payload = {
        messaging_product: 'whatsapp',
        to: '6281234567890',
        type: 'text',
        text: { preview_url: true, body: 'Check https://example.com' }
    };
    const baileys = fromCloudApiMessage(payload);
    assert.equal(baileys.text, 'Check https://example.com');
});

test('fromCloudApiMessage converts interactive buttons with header text, body, footer', () => {
    const payload = {
        messaging_product: 'whatsapp',
        to: '6281234567890',
        type: 'interactive',
        interactive: {
            type: 'button',
            header: { type: 'text', text: 'Important Notice' },
            body: { text: 'Do you confirm this booking?' },
            footer: { text: 'Bot Services' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'btn_yes', title: 'Yes, Confirm' } },
                    { type: 'reply', reply: { id: 'btn_no', title: 'Cancel' } }
                ]
            }
        }
    };
    const baileys = fromCloudApiMessage(payload);
    assert.equal(baileys.title, 'Important Notice');
    assert.equal(baileys.text, 'Do you confirm this booking?');
    assert.equal(baileys.footer, 'Bot Services');
    assert.equal(baileys.nativeFlow.length, 2);
    assert.equal(baileys.nativeFlow[0].id, 'btn_yes');
    assert.equal(baileys.nativeFlow[0].text, 'Yes, Confirm');
});

test('generateWAMessageContent wraps interactive messages in viewOnceMessage with messageVersion: 1', async () => {
    const payload = {
        messaging_product: 'whatsapp',
        type: 'interactive',
        interactive: {
            type: 'button',
            header: { type: 'text', text: 'HEADER TITLE' },
            body: { text: 'Silakan pilih tindakan:' },
            footer: { text: 'baileys-rec' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'act_1', title: 'Lanjutkan' } }
                ]
            }
        }
    };
    const content = await generateWAMessageContent(payload, {});
    assert.ok(content.viewOnceMessage, 'Must be wrapped in viewOnceMessage for WhatsApp to display');
    const inner = content.viewOnceMessage.message.interactiveMessage;
    assert.ok(inner, 'Inner interactiveMessage must exist');
    assert.equal(inner.header?.title, 'HEADER TITLE');
    assert.equal(inner.body?.text, 'Silakan pilih tindakan:');
    assert.equal(inner.footer?.text, 'baileys-rec');
    assert.equal(inner.nativeFlowMessage?.messageVersion, 1, 'messageVersion must be 1');
    assert.equal(inner.nativeFlowMessage?.buttons?.length, 1);
    assert.ok(shouldIncludeBizBinaryNode(content), 'Biz binary node must be included');
});

test('generateWAMessageContent supports carousel with swipeable cards and messageVersion 1', async () => {
    const carouselPayload = {
        messaging_product: 'whatsapp',
        type: 'interactive',
        interactive: {
            type: 'carousel',
            body: { text: 'Featured Items' },
            action: {
                cards: [
                    {
                        header: { text: 'Product 1' },
                        body: { text: 'Best item 1' },
                        buttons: [{ id: 'buy_1', text: 'Buy Now' }]
                    },
                    {
                        header: { text: 'Product 2' },
                        body: { text: 'Best item 2' },
                        buttons: [{ id: 'buy_2', text: 'Buy Later' }]
                    }
                ]
            }
        }
    };
    const content = await generateWAMessageContent(carouselPayload, {});
    assert.ok(content.viewOnceMessage, 'Carousel must be wrapped in viewOnceMessage');
    const inner = content.viewOnceMessage.message.interactiveMessage;
    assert.equal(inner.carouselMessage?.cards?.length, 2);
    assert.equal(inner.carouselMessage?.messageVersion, 1);
    assert.equal(inner.carouselMessage?.cards[0]?.nativeFlowMessage?.messageVersion, 1);
    assert.ok(shouldIncludeBizBinaryNode(content), 'Biz binary node must be included for carousel');
});

test('toCloudApiMessage converts buttons and safely handles >3 buttons by converting to list', () => {
    const manyButtons = [
        { id: '1', text: 'Opt 1' },
        { id: '2', text: 'Opt 2' },
        { id: '3', text: 'Opt 3' },
        { id: '4', text: 'Opt 4' }
    ];
    const cloudMsg = toCloudApiMessage({ text: 'Pick one', buttons: manyButtons }, '+6281234567890');
    assert.equal(cloudMsg.to, '6281234567890');
    assert.equal(cloudMsg.type, 'interactive');
    assert.equal(cloudMsg.interactive.type, 'list', 'Should convert to list because Meta Cloud API strictly forbids >3 quick reply buttons');
});

test('diagnoseMetaCloudApiError detects 24h window expiration, token issues, and sandbox whitelist', () => {
    const diag24h = diagnoseMetaCloudApiError({ code: 131047, message: 'More than 24 hours elapsed' });
    assert.ok(diag24h.title.includes('24h Rule'));

    const diagWhitelist = diagnoseMetaCloudApiError({ code: 131030, message: 'Recipient phone number not in allowed list' });
    assert.ok(diagWhitelist.title.includes('Sandbox Whitelist'));

    const diagToken = diagnoseMetaCloudApiError({ code: 190, message: 'Access token expired' });
    assert.ok(diagToken.title.includes('Access Token Expired'));
});

test('ButtonBuilder generates cta_reminder, send_location, open_webview, flow, and payment', () => {
    const builder = new ButtonBuilder()
        .addReminder("Set Alarm", "Wake up call", 1731500000)
        .addLocation("Send GPS")
        .addWebview("Portal", "https://wa.me")
        .addPayment("Bayar", { amount: { value: 50000, offset: 100 }, currency: "IDR" })
        .addCancelReminder("Batalkan", "rem_01");

    const buttons = builder.build();
    assert.equal(buttons.length, 5);
    assert.equal(buttons[0].reminder.title, "Wake up call");
    assert.equal(buttons[0].reminder.time, 1731500000);
    assert.equal(buttons[1].name, "send_location");
    assert.equal(buttons[2].webview.url, "https://wa.me");
    assert.equal(buttons[3].payment.currency, "IDR");
    assert.equal(buttons[4].cancelReminder, "rem_01");
});

test('generateWAMessageContent generates nativeFlow with cta_reminder, send_location, open_webview, flow, and locationHeader', async () => {
    const payload = {
        text: "Interactive Feature Test",
        location: {
            degreesLatitude: -6.2088,
            degreesLongitude: 106.8456,
            name: "Jakarta Monas",
            address: "Jakarta, Indonesia"
        },
        nativeFlow: [
            { reminder: { title: "Daily Sync", time: 1731500000 }, text: "⏰ Reminder" },
            { cancelReminder: "sync_123", text: "❌ Batal" },
            { sendLocation: true, text: "📍 Kirim Lokasi" },
            { webview: { url: "https://google.com" }, text: "🌐 Browser" },
            { flow: { id: "flow_123", cta: "Mulai Form", token: "tok_abc" }, text: "Buka Form" },
            { payment: { currency: "IDR", amount: { value: 25000 } }, text: "💳 Bayar 25k" },
            { order: { id: "ORD-99", status: "pending" }, text: "🛍️ Cek Pesanan" },
            { callPermission: true, text: "📞 Izin Nelpon" },
            { address: { type: "shipping" }, text: "🏠 Alamat Kirim" }
        ]
    };

    const content = await generateWAMessageContent(payload, {});
    assert.ok(content.viewOnceMessage, "Must be wrapped in viewOnceMessage");
    const inner = content.viewOnceMessage.message.interactiveMessage;
    assert.ok(inner.header?.locationMessage, "Location header must be attached");
    assert.equal(inner.header.locationMessage.degreesLatitude, -6.2088);
    assert.equal(inner.header.locationMessage.name, "Jakarta Monas");

    const btns = inner.nativeFlowMessage.buttons;
    assert.equal(btns.length, 9);
    assert.equal(btns[0].name, "cta_reminder");
    assert.equal(btns[1].name, "cta_cancel_reminder");
    assert.equal(btns[2].name, "send_location");
    assert.equal(btns[3].name, "open_webview");
    assert.equal(btns[4].name, "flow");
    assert.equal(btns[5].name, "review_and_pay");
    assert.equal(btns[6].name, "review_order");
    assert.equal(btns[7].name, "call_permission_request");
    assert.equal(btns[8].name, "address_message");

    const flowParams = JSON.parse(btns[4].buttonParamsJson);
    assert.equal(flowParams.flow_id, "flow_123");
    assert.equal(flowParams.flow_token, "tok_abc");
});

test('generateWAMessageContent handles eventMessage with flexible timestamp or Date', async () => {
    const payload = {
        event: {
            name: "WhatsApp Community Meetup 2026",
            description: "Discussing modern WhatsApp protocols",
            startDate: 1731500000,
            endDate: 1731507200,
            extraGuestsAllowed: true
        }
    };

    const content = await generateWAMessageContent(payload, {});
    assert.ok(content.eventMessage, "eventMessage must exist");
    assert.equal(content.eventMessage.name, "WhatsApp Community Meetup 2026");
    assert.equal(Number(content.eventMessage.startTime), 1731500000);
    assert.equal(Number(content.eventMessage.endTime), 1731507200);
});

test('serializeMessage accurately extracts interactive clicks, flows, and event RSVPs', () => {
    // 1. Native flow button click simulation
    const rawFlowClick = {
        key: { remoteJid: "6281234567890@s.whatsapp.net", fromMe: false, id: "MSG_001" },
        pushName: "Budi",
        message: {
            interactiveResponseMessage: {
                nativeFlowResponseMessage: {
                    name: "quick_reply",
                    paramsJson: JSON.stringify({ id: "btn_checkout", display_text: "Checkout Now" })
                }
            }
        }
    };
    const parsedFlow = serializeMessage(rawFlowClick);
    assert.equal(parsedFlow.sender, "6281234567890@s.whatsapp.net");
    assert.equal(parsedFlow.interactive?.type, "native_flow");
    assert.equal(parsedFlow.interactive?.id, "btn_checkout");
    assert.equal(parsedFlow.interactive?.text, "Checkout Now");
    assert.equal(parsedFlow.body, "btn_checkout");

    // 2. WhatsApp Flow form submission simulation
    const rawFlowForm = {
        key: { remoteJid: "6281234567890@s.whatsapp.net", fromMe: false, id: "MSG_002" },
        pushName: "Budi",
        message: {
            interactiveResponseMessage: {
                nativeFlowResponseMessage: {
                    name: "flow",
                    paramsJson: JSON.stringify({ flow_token: "tok_123", screen: "SURVEY", rating: 5 })
                }
            }
        }
    };
    const parsedForm = serializeMessage(rawFlowForm);
    assert.equal(parsedForm.interactive?.name, "flow");
    assert.equal(parsedForm.interactive?.params?.rating, 5);

    // 3. Event RSVP response simulation
    const rawEventRsvp = {
        key: { remoteJid: "6281234567890@s.whatsapp.net", fromMe: false, id: "MSG_003" },
        message: {
            eventResponseMessage: {
                response: 1, // GOING
                timestampMs: 1731500000000
            }
        }
    };
    const parsedRsvp = serializeMessage(rawEventRsvp);
    assert.equal(parsedRsvp.eventRsvp?.status, "GOING");
});


test("fromCloudApiMessage converts single product and product_list to pure proto nativeFlow", () => {
    // 1. Single Product
    const singleProdPayload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "6281234567890",
        type: "interactive",
        interactive: {
            type: "product",
            body: { text: "Check out our newest sneakers!" },
            action: {
                catalog_id: "CAT_001",
                product_retailer_id: "NIKE_AIR_MAX"
            }
        }
    };
    const baileysSingle = fromCloudApiMessage(singleProdPayload);
    assert.equal(baileysSingle.text, "Check out our newest sneakers!");
    assert.equal(baileysSingle.nativeFlow?.[0]?.name, "single_product");
    assert.equal(baileysSingle.nativeFlow?.[0]?.product_retailer_id, "NIKE_AIR_MAX");
    assert.equal(baileysSingle.nativeFlow?.[0]?.catalog_id, "CAT_001");

    // 2. Product List
    const prodListPayload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "6281234567890",
        type: "interactive",
        interactive: {
            type: "product_list",
            body: { text: "Catalog Deals" },
            action: {
                catalog_id: "CAT_001",
                sections: [
                    {
                        title: "Footwear",
                        product_items: [{ product_retailer_id: "SHOE_01" }, { product_retailer_id: "SHOE_02" }]
                    }
                ]
            }
        }
    };
    const baileysList = fromCloudApiMessage(prodListPayload);
    assert.equal(baileysList.nativeFlow?.[0]?.name, "product_list");
    assert.equal(baileysList.nativeFlow?.[0]?.catalog_id, "CAT_001");
    assert.equal(baileysList.nativeFlow?.[0]?.sections?.length, 1);
});

test("fromCloudApiMessage converts address_message, order_details, and review_and_pay", () => {
    // 1. Address Message
    const addrPayload = {
        messaging_product: "whatsapp",
        type: "interactive",
        interactive: {
            type: "address_message",
            body: { text: "Please provide shipping address" },
            action: {
                name: "address_message",
                parameters: {
                    country: "ID",
                    values: { city: "Jakarta" }
                }
            }
        }
    };
    const baileysAddr = fromCloudApiMessage(addrPayload);
    assert.equal(baileysAddr.nativeFlow?.[0]?.name, "address_message");
    assert.equal(baileysAddr.nativeFlow?.[0]?.address?.country, "ID");

    // 2. Order Details
    const orderPayload = {
        messaging_product: "whatsapp",
        type: "interactive",
        interactive: {
            type: "order_details",
            body: { text: "Review your cart" },
            action: {
                name: "review_order",
                parameters: {
                    order: {
                        order_id: "ORD_999",
                        items: [{ name: "Hoodie", price: 250000 }],
                        subtotal: 250000
                    }
                }
            }
        }
    };
    const baileysOrder = fromCloudApiMessage(orderPayload);
    assert.equal(baileysOrder.nativeFlow?.[0]?.name, "review_order");
    assert.equal(baileysOrder.nativeFlow?.[0]?.order?.order_id, "ORD_999");
});

test("fromCloudApiMessage converts poll, event, reaction, audio PTT, and sticker", () => {
    // 1. Poll
    const pollPayload = {
        messaging_product: "whatsapp",
        type: "poll",
        poll: {
            question: "Choose your favorite stack?",
            options: ["Next.js", "Express + Baileys", "FastAPI"],
            selectable_count: 1
        }
    };
    const baileysPoll = fromCloudApiMessage(pollPayload);
    assert.equal(baileysPoll.poll?.name, "Choose your favorite stack?");
    assert.equal(baileysPoll.poll?.values?.length, 3);
    assert.equal(baileysPoll.poll?.selectableCount, 1);

    // 2. Reaction
    const reactPayload = {
        messaging_product: "whatsapp",
        type: "reaction",
        reaction: {
            message_id: "MSG_XYZ",
            emoji: "⚡"
        }
    };
    const baileysReact = fromCloudApiMessage(reactPayload);
    assert.equal(baileysReact.react?.text, "⚡");
    assert.equal(baileysReact.react?.key?.id, "MSG_XYZ");

    // 3. Audio with PTT
    const audioPayload = {
        messaging_product: "whatsapp",
        type: "audio",
        audio: {
            link: "https://example.com/voice.ogg",
            ptt: true
        }
    };
    const baileysAudio = fromCloudApiMessage(audioPayload);
    assert.equal(baileysAudio.ptt, true);
    assert.equal(baileysAudio.audio?.url, "https://example.com/voice.ogg");
});

test("ButtonBuilder and Button class fluent methods generate valid proto buttons", () => {
    const builder = new ButtonBuilder()
        .addProduct("ITEM_100", "CAT_500", "View Sneaker")
        .addProductList("CAT_500", [{ title: "Popular", product_items: [] }])
        .addCatalog("628123456789@s.whatsapp.net", "Open Store")
        .addAddressRequest("Input Address", "shipping")
        .addPixPayment(50000, "pix@bank.com", "My Shop")
        .addPaymentStatus("REF_123", "success", { amount: { value: 50000, offset: 100 } });

    const buttons = builder.build();
    assert.equal(buttons.length, 6);
    assert.equal(buttons[0].name, "single_product");
    assert.equal(buttons[1].name, "product_list");
    assert.equal(buttons[2].name, "open_catalog");
    assert.equal(buttons[3].name, "address_message");
    assert.equal(buttons[4].name, "review_and_pay");
    assert.equal(buttons[5].name, "payment_status_update");
});

test("generateWAMessageContent produces valid WAProto nativeFlowMessage for single_product and product_list", async () => {
    const content = await generateWAMessageContent({
        text: "Product showcase",
        nativeFlow: [
            {
                name: "single_product",
                product_retailer_id: "SHOE_99",
                catalog_id: "CAT_99"
            },
            {
                name: "product_list",
                catalog_id: "CAT_99",
                sections: [{ title: "Sale", product_items: [] }]
            }
        ]
    }, {});

    const inner = content.viewOnceMessage?.message?.interactiveMessage || content.interactiveMessage;
    assert.ok(inner, "interactiveMessage must exist");
    const nativeFlow = inner.nativeFlowMessage;
    assert.ok(nativeFlow, "nativeFlowMessage must exist");
    assert.equal(nativeFlow.buttons.length, 2);
    assert.equal(nativeFlow.buttons[0].name, "single_product");
    const params0 = JSON.parse(nativeFlow.buttons[0].buttonParamsJson);
    assert.equal(params0.product_retailer_id, "SHOE_99");
    assert.equal(nativeFlow.buttons[1].name, "product_list");
});

import {
    generateWaveform,
    FlowBuilder,
    NewsletterHelper
} from "./lib/Utils/cloud-api-utils.js";
import { Button } from "./lib/Utils/helpers.js";

test("generateWaveform produces valid amplitude array for WhatsApp PTT voice notes", () => {
    const wave = generateWaveform(64, { min: 10, max: 90 });
    assert.equal(wave instanceof Uint8Array, true);
    assert.equal(wave.length, 64);
    for (let i = 0; i < wave.length; i++) {
        assert.ok(wave[i] >= 10 && wave[i] <= 90, `Wave value ${wave[i]} must be within range`);
    }
});

test("FlowBuilder constructs valid WhatsApp Flows v3 JSON schema and native flow button", () => {
    const fb = new FlowBuilder("flow_feedback", "Customer Feedback")
        .addScreen("SCREEN_RATING", "Rate Our Service")
        .addTextInput("cust_name", "Your Name", { required: true })
        .addDropdown("rating_stars", "Rating", ["5 Stars", "4 Stars", "3 Stars"])
        .addRadioButtons("satisfaction", "Satisfied?", [{ id: "yes", title: "Yes" }, { id: "no", title: "No" }])
        .addFooter("Submit", "complete");

    const json = fb.buildJSON();
    assert.equal(json.version, "3.1");
    assert.equal(json.screens.length, 1);
    assert.equal(json.screens[0].id, "SCREEN_RATING");
    assert.equal(json.screens[0].layout.children.length, 4);

    const btn = fb.toFlowButton("Isi Formulir", "tok_123");
    assert.equal(btn.name, "flow");
    const parsed = JSON.parse(btn.buttonParamsJson);
    assert.equal(parsed.flow_id, "flow_feedback");
    assert.equal(parsed.flow_cta, "Isi Formulir");
    assert.equal(parsed.flow_action_payload.screen, "SCREEN_RATING");
});

test("NewsletterHelper correctly identifies newsletter JIDs and formats channel messages", () => {
    assert.equal(NewsletterHelper.isNewsletterJid("123456789012345@newsletter"), true);
    assert.equal(NewsletterHelper.isNewsletterJid("6281234567890@s.whatsapp.net"), false);
    assert.equal(NewsletterHelper.isNewsletterJid("1234567890@g.us"), false);

    const msg = NewsletterHelper.buildNewsletterMessage("Breaking news announcement", {
        isForwarded: false
    });
    assert.equal(msg.text, "Breaking news announcement");
});

test("fromCloudApiMessage supports official Meta WhatsApp templates with header, params, and buttons", () => {
    const tmplPayload = {
        messaging_product: "whatsapp",
        type: "template",
        template: {
            name: "order_confirmation_v2",
            language: { code: "en_US" },
            components: [
                {
                    type: "header",
                    parameters: [{ type: "text", text: "Order Confirmed #9948" }]
                },
                {
                    type: "body",
                    parameters: [
                        { type: "text", text: "Alex" },
                        { type: "text", text: "Wireless Headphones" }
                    ]
                },
                {
                    type: "footer",
                    parameters: [{ type: "text", text: "Thank you for shopping" }]
                },
                {
                    type: "button",
                    sub_type: "url",
                    index: "0",
                    text: "Track Package",
                    parameters: [{ type: "text", text: "tracker.com/9948" }]
                },
                {
                    type: "button",
                    sub_type: "copy_code",
                    index: "1",
                    text: "Copy Promo Code",
                    parameters: [{ type: "coupon_code", coupon_code: "SAVE2026" }]
                }
            ]
        }
    };

    const converted = fromCloudApiMessage(tmplPayload);
    assert.equal(converted.title, "Order Confirmed #9948");
    assert.equal(converted.text, "Alex Wireless Headphones");
    assert.equal(converted.footer, "Thank you for shopping");
    assert.equal(converted.nativeFlow.length, 2);
    assert.equal(converted.nativeFlow[0].url, "https://tracker.com/9948");
    assert.equal(converted.nativeFlow[1].copy, "SAVE2026");
});

test("fromCloudApiMessage auto-attaches waveform to PTT audio messages", () => {
    const audioPayload = {
        messaging_product: "whatsapp",
        type: "audio",
        audio: {
            link: "https://example.com/voice.ogg",
            ptt: true
        }
    };
    const converted = fromCloudApiMessage(audioPayload);
    assert.equal(converted.ptt, true);
    assert.ok(converted.waveform instanceof Uint8Array);
    assert.equal(converted.waveform.length, 64);
});

test("Button fluent suite chains addOtp and addOrderStatus", () => {
    const btn = new Button()
        .addOtp("482910", "Salin OTP")
        .addOrderStatus("ORD_100", "completed", "Pesanan telah dikirim");

    assert.equal(btn._buttons.length, 2);
    assert.equal(btn._buttons[0].name, "cta_copy");
    const otpParams = JSON.parse(btn._buttons[0].buttonParamsJson);
    assert.equal(otpParams.copy_code, "482910");
    assert.equal(otpParams.otp, true);

    assert.equal(btn._buttons[1].name, "order_status");
    const orderParams = JSON.parse(btn._buttons[1].buttonParamsJson);
    assert.equal(orderParams.reference_id, "ORD_100");
    assert.equal(orderParams.order_status, "completed");
});

test("generateWAMessageContent produces valid single_product with businessOwnerJid fallback and params", async () => {
    const content = {
        singleProduct: {
            catalogId: "CAT_8899",
            productRetailerId: "ITEM_AIR_MAX_90",
            title: "Nike Air Max 90",
            text: "Classic premium sneaker in triple white",
            footer: "Nike Official Store",
            buttonText: "🛍️ View Sneaker"
        }
    };
    const protoMsg = await generateWAMessageContent(content, { userJid: "628123456789:2@s.whatsapp.net" });
    const inner = protoMsg?.viewOnceMessage?.message?.interactiveMessage;
    assert.ok(inner, "must produce interactiveMessage");
    assert.equal(inner.body.text, "Classic premium sneaker in triple white");
    assert.equal(inner.header.title, "Nike Air Max 90");
    assert.equal(inner.footer.text, "Nike Official Store");
    const buttons = inner.nativeFlowMessage?.buttons;
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].name, "single_product");
    const params = JSON.parse(buttons[0].buttonParamsJson);
    assert.equal(params.catalog_id, "CAT_8899");
    assert.equal(params.product_retailer_id, "ITEM_AIR_MAX_90");
    assert.equal(params.business_owner_jid, "628123456789@s.whatsapp.net");
    assert.equal(params.display_text, "🛍️ View Sneaker");
});

test("generateWAMessageContent produces valid product_list with sections and businessOwnerJid", async () => {
    const content = {
        productList: {
            catalogId: "CAT_SUMMER_2026",
            title: "Summer 2026 Collection",
            text: "Browse our newest footwear and apparel drops",
            footer: "Summer Drop",
            sections: [
                {
                    title: "Footwear",
                    highlight_label: "Best Seller",
                    product_items: [
                        { product_retailer_id: "SHOE_01" },
                        { product_retailer_id: "SHOE_02" }
                    ]
                },
                {
                    title: "Apparel",
                    rows: ["TEE_01", "HOODIE_01"]
                }
            ]
        }
    };
    const protoMsg = await generateWAMessageContent(content, { userJid: "628987654321@s.whatsapp.net" });
    const inner = protoMsg?.viewOnceMessage?.message?.interactiveMessage;
    assert.ok(inner, "must produce interactiveMessage");
    const buttons = inner.nativeFlowMessage?.buttons;
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].name, "product_list");
    const params = JSON.parse(buttons[0].buttonParamsJson);
    assert.equal(params.catalog_id, "CAT_SUMMER_2026");
    assert.equal(params.business_owner_jid, "628987654321@s.whatsapp.net");
    assert.equal(params.sections.length, 2);
    assert.equal(params.sections[0].title, "Footwear");
    assert.equal(params.sections[0].product_items[0].product_retailer_id, "SHOE_01");
    assert.equal(params.sections[1].product_items[0].product_retailer_id, "TEE_01");
});

test("generateWAMessageContent produces valid Pix Instant Payment (review_and_pay)", async () => {
    const content = {
        pixPayment: {
            pixCode: "00020126580014BR.GOV.BCB.PIX0136123e4567-e12b-12d1-a456-426614174000520400005303986540510.005802BR5913Merchant6008BRASILIA62070503***6304",
            amount: 150.50,
            currency: "BRL",
            merchantName: "São Paulo Coffee Roasters",
            text: "Order #8831 - 2x Espresso Beans",
            buttonText: "💳 Pagar com PIX"
        }
    };
    const protoMsg = await generateWAMessageContent(content, {});
    const inner = protoMsg?.viewOnceMessage?.message?.interactiveMessage;
    assert.ok(inner, "must produce interactiveMessage");
    assert.equal(inner.body.text, "Order #8831 - 2x Espresso Beans");
    const buttons = inner.nativeFlowMessage?.buttons;
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].name, "review_and_pay");
    const params = JSON.parse(buttons[0].buttonParamsJson);
    assert.equal(params.currency, "BRL");
    assert.deepEqual(params.total_amount, { value: 15050, offset: 100 });
    assert.equal(params.payment_type, "pix");
    assert.equal(params.merchant_name, "São Paulo Coffee Roasters");
    assert.ok(params.pix_code.startsWith("00020126"));
    assert.equal(params.payment_settings[0].type, "pix_dynamic_code");
    assert.equal(params.payment_settings[0].pix_dynamic_code.code, params.pix_code);
});

test("Button.addPixPayment and ButtonBuilder.addPixPayment handle flexible argument ordering", () => {
    // 1. pixKey first
    const btn1 = new Button().addPixPayment("000201PIXCODE", 50, "Store A", "Pay 50");
    const p1 = JSON.parse(btn1._buttons[0].buttonParamsJson);
    assert.equal(p1.pix_code, "000201PIXCODE");
    assert.deepEqual(p1.total_amount, { value: 5000, offset: 100 });
    assert.equal(p1.merchant_name, "Store A");

    // 2. amount first
    const btn2 = new Button().addPixPayment(75, "000201PIXCODE", "Store B", "Pay 75");
    const p2 = JSON.parse(btn2._buttons[0].buttonParamsJson);
    assert.equal(p2.pix_code, "000201PIXCODE");
    assert.deepEqual(p2.total_amount, { value: 7500, offset: 100 });
    assert.equal(p2.merchant_name, "Store B");

    // 3. ButtonBuilder addProduct & addProductList flat items
    const bb = new ButtonBuilder()
        .addProduct("PROD_99", "CAT_11", "View Item", { businessOwnerJid: "123@s.whatsapp.net" })
        .addProductList("CAT_11", ["ITEM_A", "ITEM_B"], "View List");
    assert.equal(bb.buttons[0].name, "single_product");
    assert.equal(bb.buttons[0].business_owner_jid, "123@s.whatsapp.net");
    assert.equal(bb.buttons[1].name, "product_list");
    assert.equal(bb.buttons[1].sections[0].product_items[0].product_retailer_id, "ITEM_A");
});

test("toCloudApiMessage converts single_product, product_list, and pixPayment to official Meta Cloud API formats", () => {
    // 1. Single Product
    const spPayload = toCloudApiMessage({
        singleProduct: {
            catalogId: "CAT_1",
            productRetailerId: "ITEM_1",
            title: "Featured Item",
            text: "Details about item"
        }
    }, "5511999998888");
    assert.equal(spPayload.to, "5511999998888");
    assert.equal(spPayload.interactive.type, "product");
    assert.equal(spPayload.interactive.action.catalog_id, "CAT_1");
    assert.equal(spPayload.interactive.action.product_retailer_id, "ITEM_1");

    // 2. Product List
    const plPayload = toCloudApiMessage({
        productList: {
            catalogId: "CAT_2",
            sections: [{ title: "Sneakers", product_items: [{ product_retailer_id: "SNK_1" }] }]
        }
    }, "5511999998888");
    assert.equal(plPayload.interactive.type, "product_list");
    assert.equal(plPayload.interactive.action.catalog_id, "CAT_2");
    assert.equal(plPayload.interactive.action.sections.length, 1);

    // 3. Pix Payment
    const pixPayload = toCloudApiMessage({
        pixPayment: {
            pixCode: "000201...",
            amount: 250,
            merchantName: "Coffee Brasil"
        }
    }, "5511999998888");
    assert.equal(pixPayload.interactive.type, "review_and_pay");
    assert.equal(pixPayload.interactive.action.parameters.payment_type, "pix");
    assert.equal(pixPayload.interactive.action.parameters.currency, "BRL");
    assert.deepEqual(pixPayload.interactive.action.parameters.total_amount, { value: 25000, offset: 100 });
});
