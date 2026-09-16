type SendOtpEmailInput = {
  to: string;
  otp: string;
};

type SendAccountSetupEmailInput = {
  to: string;
  token: string;
};

type SendSalesQuoteNotificationInput = {
  companyName: string;
  buyerEmail: string;
  quoteNumber: string | null;
  quoteId: string | null;
  source: 'cart' | 'quote_copy';
};

type SendQuoteRequestReceiptInput = {
  to: string;
  companyName: string;
  quoteNumber: string | null;
  items: Array<{ sku?: string; description: string; quantity: number }>;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character);
}

function resendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  return {
    apiKey,
    from: process.env.OTP_FROM_EMAIL || 'Thanda Store <sales@thanda.solar>',
  };
}

async function sendEmail(payload: { to: string; subject: string; html: string; text: string }, fromOverride?: string) {
  const { apiKey, from } = resendConfig();
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: fromOverride || from, ...payload }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend email failed: ${response.status} ${text}`);
  }

  return response.json();
}

export async function sendOtpEmail({ to, otp }: SendOtpEmailInput) {
  return sendEmail({
    to,
    subject: `Your Thanda Store login code: ${otp}`,
    html: `
      <p>Hello,</p>
      <p>Your Thanda Store login code is:</p>
      <p style="font-size:24px;font-weight:700;letter-spacing:4px">${otp}</p>
      <p>This code expires in 10 minutes.</p>
    `,
    text: `Your Thanda Store login code is ${otp}. This code expires in 10 minutes.`,
  });
}

export async function sendAccountSetupEmail({ to, token }: SendAccountSetupEmailInput) {
  const baseUrl = (process.env.PORTAL_BASE_URL || 'https://store.thanda.solar').replace(/\/$/, '');
  const setupUrl = `${baseUrl}/set-password?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to,
    subject: 'Welcome to Thanda Store - set up your account',
    html: `
      <p>Hello,</p>
      <p>Your Thanda Store account is ready.</p>
      <p>Thanda Store gives trade customers access to our current catalogue of Victron energy products, including charging, inverter, monitoring and system accessories, together with Renogy solar panels and batteries.</p>
      <p>Once signed in, you can:</p>
      <ul>
        <li>Browse current pricing, KZN stock and supplier availability.</li>
        <li>Use <strong>My favourites</strong> and <strong>Popular</strong> to find commonly purchased products quickly.</li>
        <li>Add products to your cart and use <strong>Quote me!</strong> to create a draft quote for your company.</li>
        <li>View company quotes, invoices and credit notes, download documents, and export a statement from <strong>Accounts</strong>.</li>
      </ul>
      <p>Set your password to finish setup:</p>
      <p><a href="${setupUrl}">Set your password</a></p>
      <p>This one-time link expires in 7 days. After setup, sign in with your email address and password.</p>
      <p>Regards,<br />Thanda Store</p>
    `,
    text: `Welcome to Thanda Store.\n\nThanda Store gives trade customers access to our current catalogue of Victron energy products, including charging, inverter, monitoring and system accessories, together with Renogy solar panels and batteries.\n\nOnce signed in, you can browse current pricing, KZN stock and supplier availability; use My favourites and Popular to find commonly purchased products; add products to your cart and use Quote me! to create a draft company quote; and view company quotes, invoices and credit notes, download documents, and export a statement from Accounts.\n\nSet your password: ${setupUrl}\n\nThis one-time link expires in 7 days. After setup, sign in with your email address and password.\n\nRegards,\nThanda Store`,
  });
}

export async function sendSalesQuoteNotification({ companyName, buyerEmail, quoteNumber, quoteId, source }: SendSalesQuoteNotificationInput) {
  const company = companyName.trim() || 'Unknown company';
  const quote = quoteNumber || quoteId || 'pending Xero number';
  const sourceLabel = source === 'quote_copy' ? 'a copied quote' : 'their cart';
  const recipient = process.env.SALES_QUOTE_NOTIFICATION_EMAIL || 'sales@thanda.solar';
  return sendEmail({
    to: recipient,
    subject: `New Thanda Store quote ${quote} - ${company}`,
    html: `
      <p>A Thanda Store customer has created ${sourceLabel} as a draft quote in Xero.</p>
      <p><strong>Company:</strong> ${escapeHtml(company)}<br />
      <strong>Portal user:</strong> ${escapeHtml(buyerEmail)}<br />
      <strong>Xero quote:</strong> ${escapeHtml(quote)}</p>
      <p>Please review the draft in Xero and contact the customer about accepting it.</p>
    `,
    text: `A Thanda Store customer has created ${sourceLabel} as a draft quote in Xero.\n\nCompany: ${company}\nPortal user: ${buyerEmail}\nXero quote: ${quote}\n\nPlease review the draft in Xero and contact the customer about accepting it.`,
  });
}

export async function sendQuoteRequestReceipt({ to, companyName, quoteNumber, items }: SendQuoteRequestReceiptInput) {
  const company = companyName.trim() || 'there';
  const quote = quoteNumber ? ` (${quoteNumber})` : '';
  const itemRows = items.map((item) => {
    const sku = item.sku?.trim() ? ` (${item.sku.trim()})` : '';
    return `<li>${item.quantity} x ${escapeHtml(item.description)}${escapeHtml(sku)}</li>`;
  }).join('');
  const textItems = items.map((item) => {
    const sku = item.sku?.trim() ? ` (${item.sku.trim()})` : '';
    return `- ${item.quantity} x ${item.description}${sku}`;
  }).join('\n');
  return sendEmail({
    to,
    subject: `We received your Thanda Store quote request${quote}`,
    html: `
      <p>Hello,</p>
      <p>Thank you for your quote request${quote} for ${escapeHtml(company)}.</p>
      <p>You requested:</p>
      <ul>${itemRows}</ul>
      <p>The Thanda sales team will send the final quotation shortly and confirm acceptance with you.</p>
      <p>Regards,<br />Thanda Sales</p>
    `,
    text: `Hello,\n\nThank you for your quote request${quote} for ${company}.\n\nYou requested:\n${textItems}\n\nThe Thanda sales team will send the final quotation shortly and confirm acceptance with you.\n\nRegards,\nThanda Sales`,
  }, 'Thanda Store <sales@thanda.solar>');
}
