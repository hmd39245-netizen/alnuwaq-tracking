const SALLA_TRACKING_URL =
  "https://script.google.com/macros/s/AKfycbwtcuRqFEGX3rJ1o0yN_T2i8V51le5U4aJte5xnvfNAQILRtyqvNVojT4YMDop-hDr_/exec";

export default async function handler(req, res) {
  try {
    const orderId = String(req.query.order || "").trim();

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        error: "رقم الطلب مطلوب"
      });
    }

    // =========================
    // 1) نبحث في سلة أولاً
    // =========================
    const sallaResult = await getSallaOrder(orderId);

    // إذا تعطل اتصال سلة مؤقتاً، لا نظهر حالة خاطئة
    if (sallaResult.error === "CONNECTION_ERROR") {
      return res.status(503).json({
        ok: false,
        error: "تعذر جلب حالة الطلب حاليًا، حاول مرة أخرى."
      });
    }

    // الطلب موجود في سلة
    if (sallaResult.found) {
      const salla = sallaResult.order;
      const sallaStage = mapSallaStage(salla.status);

      // -------------------------
      // حالة واضحة قبل الشحن
      // -------------------------
      if (sallaStage === 1 || sallaStage === 2) {
        const ui = uiForStage(sallaStage);

        return res.status(200).json({
          ok: true,
          source: "salla",
          orderId,

          sallaStatus: salla.status,
          rawStatus: salla.status,

          stage: sallaStage,
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

      // -------------------------
      // الصاعدي
      // -------------------------
      if (
        isSaeedi(salla.shippingCompany) &&
        (sallaStage === 3 || sallaStage === 4)
      ) {
        const ui = uiForStage(sallaStage);

        return res.status(200).json({
          ok: true,
          source: "salla",
          orderId,

          sallaStatus: salla.status,
          rawStatus: salla.status,

          stage: sallaStage,
          shippingConfirmed: true,

          ...ui,

          deliveryCompany: "الصاعدي",
          trackingNumber: "",
          trackingUrl: "",
          shipmentId: "",
          date: salla.date || "",
          packageCount: null,

          specialMessage:
            sallaStage === 3
              ? "تم شحن طلبك مع الصاعدي، والتوصيل خلال 3 أيام عمل كحد أقصى."
              : "",

          carrierLocation:
            "https://maps.app.goo.gl/NNJ3VgvtCKpaJKkcA",

          carrierPhone:
            "0566276686",

          history: []
        });
      }

      // =========================
      // حالة سلة مشحونة أو مجهولة
      // نتحقق من OTO
      // =========================
      const oto = await getOtoOrder(orderId);

      let finalStage = sallaStage;

      // إذا صياغة حالة سلة غير معروفة، لا نحولها للمرحلة 1
      // بل نعتمد على OTO
      if (finalStage === null) {
        if (oto) {
          finalStage = mapOtoStage(
            oto.status,
            oto.dcStatus,
            oto.trackingNumber,
            oto.shipmentId
          );
        } else {
          // لا نخمن
          finalStage = 1;
        }
      }

      // سلة تقول تم الشحن/جاري التوصيل
      // تظل المرحلة الثالثة مهما كانت صياغة OTO
      if (sallaStage === 3) {
        finalStage = 3;
      }

      // سلة تقول تم التسليم
      if (sallaStage === 4) {
        finalStage = 4;
      }

      const ui = uiForStage(finalStage);

      return res.status(200).json({
        ok: true,
        source: oto ? "salla+oto" : "salla",

        orderId,

        sallaStatus: salla.status,
        rawStatus: salla.status,

        stage: finalStage,
        shippingConfirmed: finalStage >= 3,

        ...ui,

        deliveryCompany:
          oto?.deliveryCompany ||
          normalizeSallaCarrier(salla.shippingCompany),

        trackingNumber:
          oto?.trackingNumber || "",

        trackingUrl:
          oto?.trackingUrl || "",

        shipmentId:
          oto?.shipmentId || "",

        date:
          oto?.date ||
          salla.date ||
          "",

        packageCount:
          oto?.packageCount ?? null,

        history:
          finalStage >= 3 && oto
            ? filterCarrierHistory(oto.history)
            : []
      });
    }

    // =========================
    // 2) طلب قديم غير موجود بالشيت
    // نعتمد على OTO
    // =========================
    const oto = await getOtoOrder(orderId);

    if (oto) {
      const stage = mapOtoStage(
        oto.status,
        oto.dcStatus,
        oto.trackingNumber,
        oto.shipmentId
      );

      const ui = uiForStage(stage);

      return res.status(200).json({
        ok: true,
        source: "oto",

        orderId,

        sallaStatus: "",
        rawStatus:
          oto.status ||
          oto.dcStatus ||
          "",

        stage,
        shippingConfirmed:
          stage >= 3,

        ...ui,

        deliveryCompany:
          oto.deliveryCompany || "",

        trackingNumber:
          oto.trackingNumber || "",

        trackingUrl:
          oto.trackingUrl || "",

        shipmentId:
          oto.shipmentId || "",

        date:
          oto.date || "",

        packageCount:
          oto.packageCount ?? null,

        history:
          stage >= 3
            ? filterCarrierHistory(oto.history)
            : []
      });
    }

    return res.status(404).json({
      ok: false,
      error: "الطلب غير موجود"
    });

  } catch (error) {
    console.error("tracking error:", error);

    return res.status(500).json({
      ok: false,
      error: "حدث خطأ في الاتصال"
    });
  }
}


// ======================================================
// تنظيف النص
// ======================================================

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


// ======================================================
// حالات سلة
// مهم: الحالة المجهولة = null وليست المرحلة 1
// ======================================================

function mapSallaStage(status) {
  const s = normalize(status);

  if (!s) {
    return null;
  }

  // المرحلة 4
  if (
    /تم التسليم|تم التوصيل|تم تسليم الطلب|delivered|completed|complete/.test(s)
  ) {
    return 4;
  }

  // المرحلة 3
  // تم الشحن وجاري التوصيل نفس المرحلة
  if (
    /تم الشحن|شحنت|مشحون|جاري التوصيل|قيد التوصيل|خرجت للتسليم|في الطريق|shipped|shipping|in.?transit|transit|out.?for.?delivery/.test(s)
  ) {
    return 3;
  }

  // المرحلة 2
  if (
    /جاري التجهيز|قيد التجهيز|تم التنفيذ|جاهز للشحن|processing|preparing|ready|packed|packing/.test(s)
  ) {
    return 2;
  }

  // المرحلة 1
  if (
    /بانتظار المراجعه|انتظار المراجعه|تحت المراجعه|قيد المراجعه|طلب جديد|تم استلام الطلب|pending|created|new/.test(s)
  ) {
    return 1;
  }

  // لا نخمن
  return null;
}


// ======================================================
// حالات OTO
// ======================================================

function mapOtoStage(
  status,
  dcStatus,
  trackingNumber,
  shipmentId
) {
  const s = normalize(
    `${status || ""} ${dcStatus || ""}`
  );

  // المرحلة 4
  if (
    /delivered|completed|complete|تم التسليم|تم التوصيل/.test(s)
  ) {
    return 4;
  }

  // المرحلة 3
  if (
    /shipped|shipping|in.?transit|transit|out.?for.?delivery|arrived.?terminal|arrived.?hub|picked.?up|pickup|collected|dispatch|تم الشحن|جاري التوصيل|قيد التوصيل|في الطريق/.test(s)
  ) {
    return 3;
  }

  // المرحلة 2
  if (
    /processing|preparing|ready|packed|packing|warehouse|جاري التجهيز/.test(s)
  ) {
    return 2;
  }

  /*
   * وجود رقم بوليصة وحده لا يعني أن الشحنة تحركت،
   * لذلك لا نجعله مرحلة 3.
   */

  return 1;
}


// ======================================================
// النص الظاهر للعميل
// ======================================================

function uiForStage(stage) {
  if (stage === 4) {
    return {
      displayStatus: "تم التسليم",
      scene: "delivered",
      sceneTitle: "تم تسليم طلبك",
      sceneText:
        "تم تسجيل الطلب كمُسلّم بنجاح."
    };
  }

  if (stage === 3) {
    return {
      displayStatus: "تم الشحن",
      scene: "shipped",
      sceneTitle: "شحنتك في الطريق",
      sceneText:
        "تم تسليم طلبك لشركة الشحن وهو مستمر في مسار التوصيل."
    };
  }

  if (stage === 2) {
    return {
      displayStatus: "جاري التجهيز",
      scene: "preparing",
      sceneTitle: "طلبك قيد التجهيز",
      sceneText:
        "يتم الآن تجهيز طلبك وتغليفه تمهيدًا للشحن."
    };
  }

  return {
    displayStatus: "تم استلام الطلب",
    scene: "received",
    sceneTitle: "تم استلام طلبك",
    sceneText:
      "تم تسجيل طلبك بنجاح وهو الآن قيد المراجعة."
  };
}


// ======================================================
// جلب الطلب من Google Sheets / سلة
// ======================================================

async function getSallaOrder(orderId) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    10000
  );

  try {
    const response = await fetch(
      `${SALLA_TRACKING_URL}?order=${encodeURIComponent(orderId)}&_=${Date.now()}`,
      {
        method: "GET",
        redirect: "follow",
        cache: "no-store",

        headers: {
          Accept:
            "application/json,text/plain,*/*"
        },

        signal: controller.signal
      }
    );

    if (!response.ok) {
      return {
        found: false,
        error: "CONNECTION_ERROR"
      };
    }

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return {
        found: false,
        error: "CONNECTION_ERROR"
      };
    }

    // هذا طلب غير موجود فعلًا
    if (
      data?.ok === false &&
      data?.error === "ORDER_NOT_FOUND"
    ) {
      return {
        found: false,
        error: null
      };
    }

    if (
      !data?.ok ||
      !data?.order
    ) {
      return {
        found: false,
        error: "CONNECTION_ERROR"
      };
    }

    return {
      found: true,
      error: null,

      order: {
        orderNumber:
          String(
            data.order.orderNumber || ""
          ).trim(),

        status:
          String(
            data.order.status || ""
          ).trim(),

        date:
          String(
            data.order.date || ""
          ).trim(),

        shippingCompany:
          String(
            data.order.shippingCompany || ""
          ).trim()
      }
    };

  } catch {
    return {
      found: false,
      error: "CONNECTION_ERROR"
    };

  } finally {
    clearTimeout(timer);
  }
}


// ======================================================
// جلب بيانات OTO
// ======================================================

async function getOtoOrder(orderId) {
  const refreshToken =
    process.env.OTO_REFRESH_TOKEN;

  if (!refreshToken) {
    return null;
  }

  try {
    const tokenResponse = await fetch(
      "https://api.tryoto.com/rest/v2/refreshToken",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "application/json"
        },

        body: JSON.stringify({
          refresh_token:
            refreshToken
        })
      }
    );

    const tokenData =
      await safeJson(tokenResponse);

    const accessToken =
      tokenData?.access_token ||
      tokenData?.accessToken ||
      tokenData?.token;

    if (
      !tokenResponse.ok ||
      !accessToken
    ) {
      return null;
    }

    const headers = {
      "Content-Type":
        "application/json",

      Accept:
        "application/json",

      Authorization:
        `Bearer ${accessToken}`
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

    const statusData =
      await safeJson(statusResponse);

    if (
      !statusResponse.ok ||
      statusData?.success === false
    ) {
      return null;
    }

    const status =
      firstValue(
        statusData,
        [
          "status",
          "orderStatus"
        ]
      );

    const dcStatus =
      firstValue(
        statusData,
        [
          "dcStatus",
          "deliveryCompanyStatus"
        ]
      );

    const trackingNumber =
      firstValue(
        statusData,
        [
          "dcTrackingNumber",
          "trackingNumber"
        ]
      );

    const shipmentId =
      firstValue(
        statusData,
        [
          "shipmentId",
          "awbNumber"
        ]
      );

    if (
      !status &&
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

      detailsData =
        await safeJson(detailsResponse);

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

      historyData =
        await safeJson(historyResponse);

    } catch {}

    return {
      status,
      dcStatus,

      deliveryCompany:
        firstValue(
          statusData,
          [
            "deliveryCompany",
            "deliveryCompanyName",
            "carrier"
          ]
        ),

      trackingNumber,

      trackingUrl:
        firstValue(
          statusData,
          [
            "trackingUrl",
            "trackingURL"
          ]
        ),

      shipmentId,

      date:
        firstValue(
          statusData,
          [
            "date",
            "updatedAt",
            "updateDate",
            "timestamp"
          ]
        ),

      packageCount:
        findNumericField(
          detailsData,
          "packageCount"
        ) ??
        findNumericField(
          statusData,
          "packageCount"
        ) ??
        null,

      history:
        normalizeHistory(
          historyData
        )
    };

  } catch {
    return null;
  }
}


// ======================================================
// شركة الشحن
// ======================================================

function normalizeSallaCarrier(company) {
  const c =
    String(company || "").trim();

  if (
    /^oto$/i.test(c) ||
    /بوابه الشحن|بوابة الشحن/i.test(c)
  ) {
    return "";
  }

  return c;
}


function isSaeedi(company) {
  const value =
    normalize(company);

  return /الصاعدي|alsaedi|al saeedi|al-saeedi|saeedi/.test(
    value
  );
}


// ======================================================
// تحديثات شركة الشحن فقط
// ======================================================

function filterCarrierHistory(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter(item => {
      const combined =
        normalize(
          `${item?.status || ""} ${item?.description || ""} ${item?.note || ""}`
        );

      // حذف تحديثات OTO الداخلية
      if (
        /تم تحديث|تم تعديل|موقع الارسال|العنوان|المرسل|sender|address|location|updated|edited|changed|created|warehouse|packing|preparing/.test(
          combined
        )
      ) {
        return false;
      }

      // تحديثات النقل الحقيقية فقط
      return /picked.?up|shipment.?picked|collected|received.?by.?carrier|carrier.?received|accepted.?by.?carrier|arrived.?terminal|arrived.?hub|in.?transit|transit|departed|out.?for.?delivery|delivery.?attempt|delivered|returned|return.?to.?sender|استلمت.*شركه.*الشحن|استلام.*شركه.*الشحن|استلم.*الناقل|تم.*استلام.*الشحنه|وصلت.*محطه|وصلت.*الفرع|غادرت.*المحطه|في.*الطريق|جاري.*التوصيل|خرجت.*للتسليم|تم.*التسليم/.test(
        combined
      );
    })
    .slice(0, 20);
}


// ======================================================
// أدوات مساعدة
// ======================================================

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}


function firstValue(obj, keys) {
  for (const key of keys) {
    const value =
      findField(obj, key);

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
  if (
    !value ||
    typeof value !== "object"
  ) {
    return undefined;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      value,
      key
    )
  ) {
    return value[key];
  }

  for (
    const child
    of Object.values(value)
  ) {
    if (
      child &&
      typeof child === "object"
    ) {
      const found =
        findField(
          child,
          key
        );

      if (
        found !== undefined
      ) {
        return found;
      }
    }
  }

  return undefined;
}


function findNumericField(obj, key) {
  const value =
    findField(obj, key);

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function normalizeHistory(raw) {
  const arrays = [];

  collectArrays(
    raw,
    arrays
  );

  const list =
    arrays
      .sort(
        (a, b) =>
          b.length - a.length
      )[0] || [];

  return list
    .map(item => {
      if (
        !item ||
        typeof item !== "object"
      ) {
        return null;
      }

      const status =
        pick(
          item,
          [
            "status",
            "orderStatus",
            "dcStatus",
            "state",
            "action"
          ]
        );

      const date =
        pick(
          item,
          [
            "date",
            "timestamp",
            "createdAt",
            "updatedAt",
            "updateDate"
          ]
        );

      const description =
        redactPII(
          pick(
            item,
            [
              "description",
              "note",
              "dcDescription",
              "message"
            ]
          )
        );

      if (
        !status &&
        !description
      ) {
        return null;
      }

      return {
        status:
          String(
            status || ""
          ),

        date:
          String(
            date || ""
          ),

        description
      };
    })
    .filter(Boolean)
    .slice(0, 50);
}


function collectArrays(
  value,
  arrays
) {
  if (!value) {
    return;
  }

  if (
    Array.isArray(value)
  ) {
    if (
      value.length &&
      value.some(
        x =>
          x &&
          typeof x === "object"
      )
    ) {
      arrays.push(value);
    }

    value.forEach(
      x =>
        collectArrays(
          x,
          arrays
        )
    );

    return;
  }

  if (
    typeof value === "object"
  ) {
    Object.values(value)
      .forEach(
        x =>
          collectArrays(
            x,
            arrays
          )
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
  let text =
    String(value || "");

  text =
    text.replace(
      /\b(?:\+?966|0)?5\d{8}\b/g,
      ""
    );

  text =
    text.replace(
      /\b\d{9,12}\b/g,
      ""
    );

  return text.trim();
}
