type SendOtpEmailInput = {
  to: string;
  otp: string;
};

type SendAccountSetupEmailInput = {
  to: string;
  token: string;
};

function resendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  return {
    apiKey,
    from: process.env.OTP_FROM_EMAIL || 'Thanda Store <sales@thanda.solar>',
  };
}

async function sendEmail(payload: { to: string; subject: string; html: string; text: string }) {
  const { apiKey, from } = resendConfig();
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, ...payload }),
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
    subject: 'Your Thanda Store login code',
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
  const baseUrl = (process.env.PORTAL_BASE_URL || 'https://oc.sensible.co.za').replace(/\/$/, '');
  const setupUrl = `${baseUrl}/set-password?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to,
    subject: 'Set up your Thanda Store account',
    html: `
      <p>Hello,</p>
      <p>Your Thanda Store account is ready. Set your password to finish setup.</p>
      <p><a href="${setupUrl}">Set your password</a></p>
      <p>This link expires in 7 days and can be used once.</p>
    `,
    text: `Set up your Thanda Store account: ${setupUrl}\n\nThis link expires in 7 days and can be used once.`,
  });
}
