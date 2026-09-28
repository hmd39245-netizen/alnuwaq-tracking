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
        error: "تعذر الاتصال بخدمة التتبع"
      });
    }

    // جلب Access Token من OTO
    const tokenResponse = await fetch(
      "https://api.tryoto.com/rest/v2/refreshToken",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          refresh_token: refreshToken
        })
      }
    );

    const tokenData = await safeJson(tokenResponse);

    const accessToken =
      tokenData?.access_token ||
      tokenData?.accessToken ||
      tokenData?.token;

    if (!tokenResponse.ok || !accessToken) {
      return res.status(502).json({
        ok: false,
        error: "تعذر الاتصال بخدمة التتبع"
      });
    }

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`
    };

    // الحالة الأساسية
    const statusResponse = await fetch(
      "https://api.tryoto.com/rest/v2/orderStatus",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          orderId
        })
      }
    );

    const statusData = await safeJson(statusResponse);

    if (!statusResponse.ok || statusData?.success === false) {
      return res.status(404).json({
        ok: false,
        error: "الطلب غير موجود"
      });
    }

    // محاولة جلب تفاصيل إضافية
    let detailsData = {};
    try {
      const detailsResponse = await fetch(
        `https://api.tryoto.com/rest/v2/orderDetails?orderId=${encodeURIComponent(orderId)}`,
        {
          method: "GET",
          headers
        }
      );

      detailsData = await safeJson(detailsResponse);
    } catch {}

    // محاولة جلب سجل التحديثات
    let historyData = {};
    try {
      const historyResponse = await fetch(
        "https://api.tryoto.com/rest/v2/orderHistory",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            orderIds: [orderId]
          })
        }
      );

      historyData = await safeJson(historyResponse);
    } catch {}

    const packageCount =
      findNumericField(detailsData, "packageCount") ??
      findNumericField(statusData, "packageCount") ??
      null;

    return res.status(200).json({
      ok: true,

      orderId,

      status:
        firstValue(statusData, [
          "status",
          "orderStatus"
        ]) || "",

      dcStatus:
        firstValue(statusData, [
          "dcStatus",
          "deliveryCompanyStatus"
        ]) || "",

      deliveryCompany:
        firstValue(statusData, [
          "deliveryCompany",
          "deliveryCompanyName",
          "carrier"
        ]) || "",

      trackingNumber:
        firstValue(statusData, [
          "dcTrackingNumber",
          "trackingNumber"
        ]) || "",

      trackingUrl:
        firstValue(statusData, [
          "trackingUrl",
          "trackingURL"
        ]) || "",

      shipmentId:
        firstValue(statusData, [
          "shipmentId",
          "awbNumber"
        ]) || "",

      date:
        firstValue(statusData, [
          "date",
          "updatedAt",
          "updateDate",
          "timestamp"
        ]) || "",

      packageCount,

      history: normalizeHistory(historyData)
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "حدث خطأ في الاتصال"
    });
  }
}


async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}


function firstValue(obj, keys) {
  for (const key of keys) {
    const value = findField(obj, key);

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return String(value);
    }
  }

  return "";
}


function findField(value, key) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, key)
  ) {
    return value[key];
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findField(child, key);

      if (found !== undefined) {
        return found;
      }
    }
  }

  return undefined;
}


function findNumericField(obj, key) {
  const value = findField(obj, key);

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function normalizeHistory(raw) {
  const arrays = [];

  collectArrays(raw, arrays);

  const list =
    arrays.sort(
      (a, b) => b.length - a.length
    )[0] || [];

  return list
    .map((item) => {
      if (
        !item ||
        typeof item !== "object"
      ) {
        return null;
      }

      const status = pick(item, [
        "status",
        "orderStatus",
        "dcStatus",
        "state",
        "action"
      ]);

      const date = pick(item, [
        "date",
        "timestamp",
        "createdAt",
        "updatedAt",
        "updateDate"
      ]);

      const description = redactPII(
        pick(item, [
          "description",
          "note",
          "dcDescription",
          "message"
        ])
      );

      if (!status && !description) {
        return null;
      }

      return {
        status: String(status || ""),
        date: String(date || ""),
        description: String(description || "")
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const dateA =
        Date.parse(a.date) || 0;

      const dateB =
        Date.parse(b.date) || 0;

      return dateB - dateA;
    })
    .slice(0, 12);
}


function collectArrays(value, output) {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return;
  }

  if (Array.isArray(value)) {
    if (
      value.some(
        (item) =>
          item &&
          typeof item === "object"
      )
    ) {
      output.push(value);
    }

    for (const child of value) {
      collectArrays(child, output);
    }

    return;
  }

  for (
    const [key, child]
    of Object.entries(value)
  ) {

    if (
      Array.isArray(child) &&
      /history|status|events|actions/i.test(key)
    ) {
      output.push(child);
    }

    if (
      child &&
      typeof child === "object"
    ) {
      collectArrays(child, output);
    }
  }
}


function pick(obj, keys) {
  for (const key of keys) {
    if (
      obj[key] !== undefined &&
      obj[key] !== null &&
      obj[key] !== ""
    ) {
      return obj[key];
    }
  }

  return "";
}


function redactPII(text) {
  return String(text || "")
    .replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      "[محجوب]"
    )
    .replace(
      /\+?\d[\d\s-]{8,}\d/g,
      "[محجوب]"
    );
}
