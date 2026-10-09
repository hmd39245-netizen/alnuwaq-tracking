const SALLA_TRACKING_URL =
  "https://script.google.com/macros/s/AKfycbwtcuRqFEGX3rJ1o0yN_T2i8V51le5U4aJte5xnvfNAQILRtyqvNVojT4YMDop-hDr_/exec";

export default async function handler(req, res) {
  try {
    const query = String(req.query.order || "").trim();

    if (!query) {
      return res.status(400).json({ ok: false, error: "رقم الطلب مطلوب" });
    }

    // 1) سلة هي المصدر الرئيسي لحالة الطلب.
    const salla = await getSallaOrder(query);

    if (salla) {
      const stage = mapSallaStage(salla.status);
      const ui = uiForStage(stage, salla.status);

      // قبل الشحن: لا نسمح لـ OTO بالتأثير على الحالة أو إظهار بيانات شحن.
      if (stage < 3) {
        return res.status(200).json({
          ok: true,
          source: "salla",
          orderId: query,
          sallaStatus: salla.status,
          rawStatus: salla.status,
          stage,
          shippingConfirmed: false,
          ...ui,
          deliveryCompany: "",
          trackingNumber: "",
          trackingUrl: "",
          shipmentId: "",
          date: salla.date || "",
          packageCount: null,
          history: []
        });
      }

      // الصاعدي لا يعتمد على OTO.
      if (isSaeedi(salla.shippingCompany)) {
        return res.status(200).json({
          ok: true,
          source: "salla",
          orderId: query,
          sallaStatus: salla.status,
          rawStatus: salla.status,
          stage,
          shippingConfirmed: true,
          ...ui,
          deliveryCompany: "الصاعدي",
          trackingNumber: "",
          trackingUrl: "",
          shipmentId: "",
          date: salla.date || "",
          packageCount: null,
          specialMessage:
            stage === 3
              ? "تم شحن طلبك مع الصاعدي، والتوصيل خلال 3 أيام عمل كحد أقصى."
              : "",
          carrierLocation: "https://maps.app.goo.gl/NNJ3VgvtCKpaJKkcA",
          carrierPhone: "0566276686",
          history: []
        });
      }

      // بعد أن تؤكد سلة مرحلة الشحن فقط نأخذ تفاصيل الناقل من OTO.
      const oto = await getOtoOrder(query);

      return res.status(200).json({
        ok: true,
        source: oto ? "salla+oto" : "salla",
        orderId: query,
        sallaStatus: salla.status,
        rawStatus: salla.status,
        stage,
        shippingConfirmed: true,
        ...ui,
        deliveryCompany: oto?.deliveryCompany || normalizeSallaCarrier(salla.shippingCompany),
        trackingNumber: oto?.trackingNumber || "",
        trackingUrl: oto?.trackingUrl || "",
        shipmentId: oto?.shipmentId || "",
        date: oto?.date || salla.date || "",
        packageCount: oto?.packageCount ?? null,
        history: oto ? filterCarrierHistory(oto.history) : []
      });
    }

    // 2) الطلبات القديمة التي لم تدخل الشيت: نرجع إلى OTO فقط.
    const oto = await getOtoOrder(query);

    if (oto) {
      const stage = mapOtoStage(oto.status, oto.dcStatus);
      const ui = uiForStage(stage, `${oto.status || ""} ${oto.dcStatus || ""}`);

      return res.status(200).json({
        ok: true,
        source: "oto",
        orderId: query,
        sallaStatus: "",
        rawStatus: oto.status || oto.dcStatus || "",
        stage,
        shippingConfirmed: stage >= 3,
        ...ui,
        deliveryCompany: oto.deliveryCompany || "",
        trackingNumber: oto.trackingNumber || "",
        trackingUrl: oto.trackingUrl || "",
        shipmentId: oto.shipmentId || "",
        date: oto.date || "",
        packageCount: oto.packageCount ?? null,
        history: stage >= 3 ? filterCarrierHistory(oto.history) : []
      });
    }

    return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
  } catch (error) {
    console.error("tracking error", error);
    return res.status(500).json({ ok: false, error: "حدث خطأ في الاتصال" });
  }
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

function mapSallaStage(status) {
  const s = normalize(status);

  if (/تم التسليم|تم التوصيل|delivered|completed|complete/.test(s)) return 4;
  if (/تم الشحن|جاري التوصيل|خرجت للتسليم|shipped|in.?transit|transit|out.?for.?delivery/.test(s)) return 3;
  if (/جاري التجهيز|تم التنفيذ|قيد التجهيز|processing|preparing|ready|packed|packing/.test(s)) return 2;

  return 1;
}

function mapOtoStage(status, dcStatus) {
  const s = normalize(`${status || ""} ${dcStatus || ""}`);

  if (/delivered|completed|complete|تم التسليم|تم التوصيل/.test(s)) return 4;
  if (/out.?for.?delivery|shipped|in.?transit|transit|arrived.?terminal|arrived.?hub|picked.?up|pickup|collected|dispatch|تم الشحن|جاري التوصيل/.test(s)) return 3;
  if (/processing|preparing|ready|packed|packing|warehouse|جاري التجهيز/.test(s)) return 2;
  return 1;
}

function uiForStage(stage, rawStatus = "") {
  if (stage === 4) {
    return {
      displayStatus: "تم التسليم",
      scene: "delivered",
      sceneTitle: "تم تسليم طلبك",
      sceneText: "تم تسجيل الطلب كمُسلّم بنجاح."
    };
  }

  if (stage === 3) {
    const raw = normalize(rawStatus);
    const out = /جاري التوصيل|خرجت للتسليم|out.?for.?delivery/.test(raw);

    return {
      displayStatus: out ? "جاري التوصيل" : "تم الشحن",
      scene: "shipped",
      sceneTitle: out ? "شحنتك في الطريق إليك" : "شحنتك في الطريق",
      sceneText: out
        ? "خرجت الشحنة للتسليم وهي في طريقها إليك."
        : "تم تسليم طلبك لشركة الشحن وهو مستمر في مسار التوصيل."
    };
  }

  if (stage === 2) {
    return {
      displayStatus: "جاري التجهيز",
      scene: "preparing",
      sceneTitle: "طلبك قيد التجهيز",
      sceneText: "يتم الآن تجهيز طلبك وتغليفه تمهيدًا للشحن."
    };
  }

  return {
    displayStatus: "تم استلام الطلب",
    scene: "received",
    sceneTitle: "تم استلام طلبك",
    sceneText: "تم تسجيل طلبك بنجاح وهو الآن قيد المراجعة."
  };
}

async function getSallaOrder(orderId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(
      `${SALLA_TRACKING_URL}?order=${encodeURIComponent(orderId)}&_=${Date.now()}`,
      {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        headers: { Accept: "application/json,text/plain,*/*" },
        signal: controller.signal
      }
    );

    if (!response.ok) return null;

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }

    if (!data?.ok || !data?.order) return null;

    return {
      orderNumber: String(data.order.orderNumber || "").trim(),
      status: String(data.order.status || "").trim(),
      date: String(data.order.date || "").trim(),
      shippingCompany: String(data.order.shippingCompany || "").trim()
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
        body: JSON.stringify({ orderId })
      }
    );

    const statusData = await safeJson(statusResponse);

    if (!statusResponse.ok || statusData?.success === false) return null;

    const status = firstValue(statusData, ["status", "orderStatus"]);
    const dcStatus = firstValue(statusData, ["dcStatus", "deliveryCompanyStatus"]);
    const trackingNumber = firstValue(statusData, ["dcTrackingNumber", "trackingNumber"]);
    const shipmentId = firstValue(statusData, ["shipmentId", "awbNumber"]);

    if (!status && !dcStatus && !trackingNumber && !shipmentId) return null;

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
      status,
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

function normalizeSallaCarrier(company) {
  const c = String(company || "").trim();

  if (/^oto$/i.test(c) || /بوابه الشحن|بوابة الشحن/i.test(c)) {
    return "";
  }

  return c;
}

function isSaeedi(company) {
  const value = normalize(company);

  return /الصاعدي|alsaedi|al saeedi|al-saeedi|saeedi/.test(value);
}

function filterCarrierHistory(items) {
  if (!Array.isArray(items)) return [];

  return items
    .filter(item => {
      const combined = normalize(
        `${item?.status || ""} ${item?.description || ""} ${item?.note || ""}`
      );

      if (
        /تم تحديث|تم تعديل|موقع الارسال|موقع الإرسال|العنوان|المرسل|sender|address|location|updated|edited|changed|created|warehouse|packing|preparing/.test(
          combined
        )
      ) {
        return false;
      }

      return /picked.?up|shipment.?picked|collected|received.?by.?carrier|carrier.?received|accepted.?by.?carrier|arrived.?terminal|arrived.?hub|in.?transit|transit|departed|out.?for.?delivery|delivery.?attempt|delivered|returned|return.?to.?sender|استلمت.*شركة.*الشحن|استلام.*شركة.*الشحن|استلم.*الناقل|تم.*استلام.*الشحنه|وصلت.*محطه|وصلت.*الفرع|غادرت.*المحطه|في.*الطريق|جاري.*التوصيل|خرجت.*للتسليم|تم.*التسليم/.test(
        combined
      );
    })
    .slice(0, 20);
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

  if (Object.prototype.hasOwnProperty.call(value, key)) {
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
    .map(item => {
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
    .slice(0, 50);
}

function collectArrays(value, arrays) {
  if (!value) return;

  if (Array.isArray(value)) {
    if (
      value.length &&
      value.some(x => x && typeof x === "object")
    ) {
      arrays.push(value);
    }

    value.forEach(x =>
      collectArrays(x, arrays)
    );

    return;
  }

  if (typeof value === "object") {
    Object.values(value).forEach(x =>
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
