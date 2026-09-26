export default async function handler(req, res) {
  try {
    const orderId = String(req.query.order || "").trim();

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        error: "رقم الطلب مطلوب"
      });
    }

    const refreshToken = process.env.OTO_REFRESH_TOKEN;

    if (!refreshToken) {
      return res.status(500).json({
        ok: false,
        error: "OTO_REFRESH_TOKEN غير موجود"
      });
    }

    // 1) استخراج Access Token
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

    if (!accessToken) {
      return res.status(500).json({
        ok: false,
        error: "تعذر استخراج Access Token",
        oto: tokenData
      });
    }

    // 2) جلب حالة الطلب من OTO
    const otoResponse = await fetch(
      "https://api.tryoto.com/rest/v2/orderStatus",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          orderId
        })
      }
    );

    const data = await otoResponse.json();

    return res.status(otoResponse.ok ? 200 : 404).json({
      ok: otoResponse.ok,
      orderId,
      oto: data
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
