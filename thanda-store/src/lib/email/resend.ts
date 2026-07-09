type SendOtpEmailInput = {
  to: string;
  username: string;
  otp: string;
};

export async function sendOtpEmail({ to, username, otp }: SendOtpEmailInput) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`RESEND_API_KEY is not configured. OTP for ${username}: ${otp}`);
    return { skipped: true };
  }

  const from = process.env.OTP_FROM_EMAIL || 'Thanda Store <login@thanda.solar>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: 'Your Thanda Store login code',
      html: `
        <p>Hello ${username},</p>
        <p>Your Thanda Store login code is:</p>
        <p style="font-size:24px;font-weight:700;letter-spacing:4px">${otp}</p>
        <p>This code expires in 10 minutes.</p>
      `,
      text: `Your Thanda Store login code is ${otp}. This code expires in 10 minutes.`,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend email failed: ${response.status} ${text}`);
  }

  return response.json();
}
