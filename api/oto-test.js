export default async function handler(req, res) {
  try {
    const refreshToken = process.env.OTO_REFRESH_TOKEN;

    if (!refreshToken) {
      return res.status(500).json({
        ok: false,
        error: "OTO_REFRESH_TOKEN غير موجود في Vercel"
      });
    }

    // 1) نجيب Access Token من OTO
    const tokenResponse = await fetch(
      "https://api.tryoto.com/rest/v2/refreshToken",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          refresh_token: refreshToken
        })
      }
    );

    const tokenData = await tokenResponse.json();

    const accessToken =
      tokenData.access_token ||
      tokenData.accessToken ||
      tokenData.token;

    if (!tokenResponse.ok || !accessToken) {
      return res.status(500).json({
        ok: false,
        step: "refreshToken",
        otoResponse: tokenData
      });
    }

    // 2) اختبار الاتصال بالحساب
    const accountResponse = await fetch(
      "https://api.tryoto.com/rest/v2/accountInfo",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      }
    );

    const accountData = await accountResponse.json();

    return res.status(accountResponse.ok ? 200 : 500).json({
      ok: accountResponse.ok,
      message: accountResponse.ok
        ? "تم الاتصال بـ OTO بنجاح"
        : "تم الحصول على التوكن لكن فشل اختبار الحساب",
      account: accountData
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
