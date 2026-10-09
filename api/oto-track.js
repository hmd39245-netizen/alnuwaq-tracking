const SALLA_TRACKING_URL =
  "https://script.google.com/macros/s/AKfycbwtcuRqFEGX3rJ1o0yN_T2i8V51le5U4aJte5xnvfNAQILRtyqvNVojT4YMDop-hDr_/exec";

export default async function handler(req, res) {
  try {
    const orderId = String(req.query.order || "").trim();

    if (!orderId) {
      return res.status(400).json({ ok: false, error: "رقم الطلب مطلوب" });
    }

    // 1) سلة أولًا دائمًا
    const sallaOrder = await getSallaOrder(orderId);

    if (sallaOrder) {
      const sallaStatus = sallaOrder.status || "";

      // إذا الطلب لم يدخل مرحلة الشحن في سلة، نتوقف هنا ولا نسأل OTO أصلًا.
      if (!isShippingStage(sallaStatus)) {
        return res.status(200).json({
          ok: true,
          source: "salla",
          orderId,
          status: sallaStatus,
          sallaStatus,
          sallaShippingCompany: sallaOrder.shippingCompany || "",
          dcStatus: "",
          deliveryCompany: sallaOrder.shippingCompany || "",
          trackingNumber: "",
          trackingUrl: "",
          shipmentId: "",
          date: sallaOrder.date || "",
          packageCount: null,
          history: []
        });
      }

      // الصاعدي: رسالة خاصة بدون OTO
      if (isSaeedi(sallaOrder.shippingCompany)) {
        return res.status(200).json({
          ok: true,
          source: "salla",
          orderId,
          status: sallaStatus,
          sallaStatus,
          sallaShippingCompany: sallaOrder.shippingCompany || "",
          dcStatus: "",
          deliveryCompany: "الصاعدي",
          trackingNumber: "",
          trackingUrl: "",
          shipmentId: "",
          date: sallaOrder.date || "",
          packageCount: null,
          specialMessage: "تم شحن طلبك مع الصاعدي، والتوصيل خلال 3 أيام عمل كحد أقصى.",
          carrierLocation: "https://maps.app.goo.gl/NNJ3VgvtCKpaJKkcA",
          history: []
        });
      }
    }

    // 2) نصل إلى OTO فقط بعد أن تقول سلة إن الطلب دخل مرحلة الشحن.
    // الطلبات القديمة غير الموجودة في سلة مسموح لها بالرجوع إلى OTO مباشرة.
    const otoData = await getOtoOrder(orderId);

    if (otoData) {
      return res.status(200).json({
        ok: true,
        source: "oto",
        orderId,
        sallaStatus: sallaOrder?.status || "",
        sallaShippingCompany: sallaOrder?.shippingCompany || "",
        status: otoData.status || sallaOrder?.status || "",
        dcStatus: otoData.dcStatus || "",
        deliveryCompany: otoData.deliveryCompany || sallaOrder?.shippingCompany || "",
        trackingNumber: otoData.trackingNumber || "",
        trackingUrl: otoData.trackingUrl || "",
        shipmentId: otoData.shipmentId || "",
        date: otoData.date || sallaOrder?.date || "",
        packageCount: otoData.packageCount,
        history: otoData.history || []
      });
    }

    // سلة تقول إنه شحن، لكن OTO ما رجع بيانات لسه.
    if (sallaOrder) {
      return res.status(200).json({
        ok: true,
        source: "salla",
        orderId,
        status: sallaOrder.status || "",
        sallaStatus: sallaOrder.status || "",
        sallaShippingCompany: sallaOrder.shippingCompany || "",
        dcStatus: "",
        deliveryCompany: sallaOrder.shippingCompany || "",
        trackingNumber: "",
        trackingUrl: "",
        shipmentId: "",
        date: sallaOrder.date || "",
        packageCount: null,
        history: []
      });
    }

    return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
  } catch {
    return res.status(500).json({ ok: false, error: "حدث خطأ في الاتصال" });
  }
}

function isShippingStage(status) {
  const s = String(status || "").toLowerCase().replace(/\s+/g, " ").trim();

  return /تم الشحن|جاري التوصيل|خرجت للتسليم|تم التسليم|تم التوصيل|shipped|in.?transit|transit|out.?for.?delivery|delivered|complete|completed/.test(s);
}

async function getSallaOrder(orderId) {
  try {
    const response = await fetch(
      `${SALLA_TRACKING_URL}?order=${encodeURIComponent(orderId)}`,
      {
        method: "GET",
        redirect: "follow"
      }
    );

    if (!response.ok) return null;

    const data = await safeJson(response);

    if (!data?.ok || !data?.order) return null;

    return {
      orderNumber: String(data.order.orderNumber || "").trim(),
      status: String(data.order.status || "").trim(),
      date: String(data.order.date || "").trim(),
      shippingCompany: String(data.order.shippingCompany || "").trim()
    };
  } catch {
    return null;
  }
}

async function getOtoOrder(orderId) {
  const refreshToken = process.env.OTO_REFRESH_TOKEN;

  if (!refreshToken) return null;

  try {
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

    if (!tokenResponse.ok || !accessToken) return null;

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`
    };

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
      return null;
    }

    const otoStatus = firstValue(statusData, [
      "status",
      "orderStatus"
    ]);

    const dcStatus = firstValue(statusData, [
      "dcStatus",
      "deliveryCompanyStatus"
    ]);

    const trackingNumber = firstValue(statusData, [
      "dcTrackingNumber",
      "trackingNumber"
    ]);

    const shipmentId = firstValue(statusData, [
      "shipmentId",
      "awbNumber"
    ]);

    if (
      !otoStatus &&
      !dcStatus &&
      !trackingNumber &&
      !shipmentId
    ) {
      return null;
    }

    let detailsData = {};
    let historyData = {};

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

    return {
      status: otoStatus,
      dcStatus,

      deliveryCompany: firstValue(statusData, [
        "deliveryCompany",
        "deliveryCompanyName",
        "carrier"
      ]),

      trackingNumber,

      trackingUrl: firstValue(statusData, [
        "trackingUrl",
        "trackingURL"
      ]),

      shipmentId,

      date: firstValue(statusData, [
        "date",
        "updatedAt",
        "updateDate",
        "timestamp"
      ]),

      packageCount:
        findNumericField(detailsData, "packageCount") ??
        findNumericField(statusData, "packageCount") ??
        null,

      history: normalizeHistory(historyData)
    };
  } catch {
    return null;
  }
}

function isSaeedi(company) {
  const value = String(company || "")
    .trim()
    .toLowerCase();

  return (
    value.includes("الصاعدي") ||
    value.includes("alsaedi") ||
    value.includes("al saeedi") ||
    value.includes("al-saeedi") ||
    value.includes("saeedi")
  );
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
    arrays.sort((a, b) => b.length - a.length)[0] || [];

  return list
    .map((item) => {
      if (!item || typeof item !== "object") {
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
        description
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function collectArrays(value, arrays) {
  if (!value) return;

  if (Array.isArray(value)) {
    if (
      value.length &&
      value.some(
        (x) => x && typeof x === "object"
      )
    ) {
      arrays.push(value);
    }

    value.forEach((x) =>
      collectArrays(x, arrays)
    );

    return;
  }

  if (typeof value === "object") {
    Object.values(value).forEach((x) =>
      collectArrays(x, arrays)
    );
  }
}

function pick(obj, keys) {
  for (const key of keys) {
    if (
      obj?.[key] !== undefined &&
      obj?.[key] !== null &&
      obj?.[key] !== ""
    ) {
      return obj[key];
    }
  }

  return "";
}

function redactPII(value) {
  let text = String(value || "");

  text = text.replace(
    /\b(?:\+?966|0)?5\d{8}\b/g,
    ""
  );

  text = text.replace(
    /\b\d{9,12}\b/g,
    ""
  );

  return text.trim();
}
