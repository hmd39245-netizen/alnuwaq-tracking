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
        error: "تعذر الاتصال بـ OTO"
      });
    }

    const otoResponse = await fetch(
      "https://api.tryoto.com/rest/v2/orderStatus",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          orderId
        })
      }
    );

    const data = await otoResponse.json();

    if (!otoResponse.ok || data?.success === false) {
      return res.status(404).json({
        ok: false,
        error: "الطلب غير موجود"
      });
    }

    return res.status(200).json({
      ok: true,
      orderId,
      status: data.status || "",
      dcStatus: data.dcStatus || "",
      deliveryCompany: data.deliveryCompany || "",
      trackingNumber: data.dcTrackingNumber || "",
      trackingUrl: data.trackingUrl || "",
      shipmentId: data.shipmentId || "",
      date: data.date || ""
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "حدث خطأ في الاتصال"
    });
  }
}
