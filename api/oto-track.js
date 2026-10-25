const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const rateStore = globalThis.__alnuwaqTrackingRateStore || new Map();
globalThis.__alnuwaqTrackingRateStore = rateStore;

const SALLA_TRACKING_URL =
  "https://script.google.com/macros/s/AKfycbwtcuRqFEGX3rJ1o0yN_T2i8V51le5U4aJte5xnvfNAQILRtyqvNVojT4YMDop-hDr_/exec";

export default async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "الطريقة غير مسموحة" });
  }

  if (!checkRateLimit(req, res)) return;

  const query = String(req.query.order || "").trim();

  if (!query) {
    return res.status(400).json({
      ok: false,
      error: "رقم الطلب أو رقم التتبع مطلوب"
    });
  }

  if (!isPossibleSearchNumber(query)) {
    return res.status(404).json({
      ok: false,
      error: "الطلب أو رقم التتبع غير موجود"
    });
  }

  try {
    const token = await getAccessToken();
    const sallaResult = await getSallaOrder(query);

    if (sallaResult.type === "error") {
      return res.status(503).json({
        ok: false,
        error: "تعذر قراءة حالة الطلب من سلة حالياً، حاول مرة أخرى"
      });
    }

    // ==================================================
    // الطلب موجود في سلة
    // ==================================================
    if (sallaResult.type === "found") {
      const salla = sallaResult.order;
      const sallaStage = classifySallaStatus(salla.status);

      // الصاعدي يعتمد على حالة سلة مباشرة
      if (isSaeedi(salla.shippingCompany)) {
        return res.status(200).json(
          buildSaeediResponse(query, salla, sallaStage)
        );
      }

      // مهم: نفحص OTO حتى لو سلة ما زالت تقول "جاري التجهيز"
      const oto = token
        ? await getOtoOrder(salla.orderNumber || query, token)
        : null;

      const trackingNumber = oto?.trackingNumber || "";

      const carrierCode = carrierCodeFromName(
        oto?.deliveryCompany || salla.shippingCompany
      );

      let shipment = null;

      if (
        token &&
        trackingNumber &&
        carrierCode &&
        isPossibleTrackingNumber(trackingNumber)
      ) {
        shipment = await trackShipment(
          trackingNumber,
          carrierCode,
          token
        );
      }

      let effectiveStage = sallaStage;

      if (oto) {
        effectiveStage = Math.max(
          effectiveStage,
          classifyOtoStatus(
            oto.status,
            oto.dcStatus
          )
        );
      }

      if (shipment) {
        effectiveStage = Math.max(
          effectiveStage,
          classifyTrackingStage(
            shipment
          )
        );
      }

      const hasShippingEvidence = Boolean(
        shipment ||
        trackingNumber ||
        oto?.shipmentId ||
        (
          oto &&
          classifyOtoStatus(
            oto.status,
            oto.dcStatus
          ) >= 3
        )
      );

      // الطلب فعلاً لم يُشحن بعد
      if (
        sallaStage < 3 &&
        !hasShippingEvidence
      ) {
        return res.status(200).json({
          ok: true,

          source: "salla",

          inputType: "order",

          orderId:
            salla.orderNumber ||
            query,

          stage:
            sallaStage,

          ...uiForStage(
            sallaStage
          ),

          rawStatus:
            salla.status,

          deliveryCompany: "",

          trackingNumber: "",

          trackingUrl: "",

          shipmentId: "",

          packageCount:
            null,

          date:
            salla.date ||
            "",

          history: [],

          isSaeedi:
            false
        });
      }

      const history =
        mergeHistories(
          shipment?.history ||
          [],

          buildCarrierHistory(
            oto
          )
        );

      return res.status(200).json({
        ok: true,

        source:
          shipment
            ? "salla+tracking"
            : oto
              ? "salla+oto"
              : "salla",

        inputType:
          "order",

        orderId:
          salla.orderNumber ||
          query,

        stage:
          effectiveStage,

        ...uiForStage(
          effectiveStage
        ),

        rawStatus:
          shipment?.otoStatus ||
          shipment?.dcStatus ||
          oto?.status ||
          oto?.dcStatus ||
          salla.status ||
          "",

        deliveryCompany:
          normalizeCarrierName(
            shipment?.deliveryCompany ||
            oto?.deliveryCompany
          ) ||
          cleanSallaCarrier(
            salla.shippingCompany
          ),

        trackingNumber:
          shipment?.trackingNumber ||
          trackingNumber ||
          "",

        trackingUrl:
          shipment?.trackingUrl ||
          oto?.trackingUrl ||
          "",

        shipmentId:
          shipment?.shipmentId ||
          oto?.shipmentId ||
          "",

        packageCount:
          oto?.packageCount ??
          null,

        date:
          shipment?.date ||
          oto?.date ||
          salla.date ||
          "",

        history:
          effectiveStage >= 3
            ? history
            : [],

        isSaeedi:
          false
      });
    }

    // ==================================================
    // طلب قديم غير موجود في Google Sheet - نجرب OTO
    // ==================================================
    if (
      token &&
      isPossibleOrderNumber(
        query
      )
    ) {
      const oto =
        await getOtoOrder(
          query,
          token
        );

      if (oto) {
        let stage =
          classifyOtoStatus(
            oto.status,
            oto.dcStatus
          );

        const carrierCode =
          carrierCodeFromName(
            oto.deliveryCompany
          );

        let shipment =
          null;

        if (
          oto.trackingNumber &&
          carrierCode &&
          isPossibleTrackingNumber(
            oto.trackingNumber
          )
        ) {
          shipment =
            await trackShipment(
              oto.trackingNumber,
              carrierCode,
              token
            );
        }

        if (shipment) {
          stage =
            Math.max(
              stage,
              classifyTrackingStage(
                shipment
              )
            );
        }

        const history =
          mergeHistories(
            shipment?.history ||
            [],

            buildCarrierHistory(
              oto
            )
          );

        return res.status(200).json({
          ok: true,

          source:
            shipment
              ? "oto+tracking"
              : "oto",

          inputType:
            "order",

          orderId:
            query,

          stage,

          ...uiForStage(
            stage
          ),

          rawStatus:
            shipment?.otoStatus ||
            shipment?.dcStatus ||
            oto.status ||
            oto.dcStatus ||
            "",

          deliveryCompany:
            normalizeCarrierName(
              shipment?.deliveryCompany ||
              oto.deliveryCompany
            ),

          trackingNumber:
            shipment?.trackingNumber ||
            oto.trackingNumber ||
            "",

          trackingUrl:
            shipment?.trackingUrl ||
            oto.trackingUrl ||
            "",

          shipmentId:
            shipment?.shipmentId ||
            oto.shipmentId ||
            "",

          packageCount:
            oto.packageCount ??
            null,

          date:
            shipment?.date ||
            oto.date ||
            "",

          history:
            stage >= 3
              ? history
              : [],

          isSaeedi:
            false
        });
      }
    }

    // ==================================================
    // بحث مباشر برقم تتبع أرامكس
    // ==================================================
    if (
      token &&
      isPossibleTrackingNumber(
        query
      )
    ) {
      const shipment =
        await trackShipment(
          query,
          "aramex",
          token
        );

      if (shipment) {
        const stage =
          classifyTrackingStage(
            shipment
          );

        return res.status(200).json({
          ok: true,

          source:
            "tracking",

          inputType:
            "tracking",

          orderId:
            "",

          stage,

          ...uiForStage(
            stage
          ),

          rawStatus:
            shipment.otoStatus ||
            shipment.dcStatus ||
            "",

          deliveryCompany:
            "Aramex",

          trackingNumber:
            shipment.trackingNumber ||
            query,

          trackingUrl:
            shipment.trackingUrl ||
            "",

          shipmentId:
            shipment.shipmentId ||
            query,

          packageCount:
            null,

          date:
            shipment.date ||
            "",

          history:
            shipment.history ||
            [],

          isSaeedi:
            false
        });
      }
    }

    return res.status(404).json({
      ok: false,
      error: "الطلب أو رقم التتبع غير موجود"
    });

  } catch (error) {
    console.error(
      "tracking error",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "حدث خطأ في الاتصال"
    });
  }
}


// ==================================================
// الحماية
// ==================================================

function getClientIp(req) {
  const candidates = [
    req.headers?.["x-vercel-forwarded-for"],
    req.headers?.["x-forwarded-for"],
    req.headers?.["x-real-ip"]
  ];

  for (
    const value
    of candidates
  ) {
    if (!value) continue;

    const ip =
      String(value)
        .split(",")[0]
        .trim();

    if (ip) {
      return ip;
    }
  }

  return "unknown";
}


function applySecurityHeaders(res) {
  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, max-age=0, must-revalidate"
  );

  res.setHeader(
    "Pragma",
    "no-cache"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );

  res.setHeader(
    "X-Robots-Tag",
    "noindex, nofollow, noarchive"
  );
}


function checkRateLimit(
  req,
  res
) {
  const now =
    Date.now();

  const ip =
    getClientIp(
      req
    );

  const current =
    rateStore.get(
      ip
    );

  if (
    !current ||
    now -
      current.startedAt >=
      RATE_LIMIT_WINDOW_MS
  ) {
    rateStore.set(
      ip,
      {
        startedAt:
          now,

        count:
          1
      }
    );

    return true;
  }

  current.count += 1;

  if (
    current.count >
    RATE_LIMIT_MAX_REQUESTS
  ) {
    const retryAfter =
      Math.max(
        1,

        Math.ceil(
          (
            RATE_LIMIT_WINDOW_MS -
            (
              now -
              current.startedAt
            )
          ) /
          1000
        )
      );

    res.setHeader(
      "Retry-After",
      String(
        retryAfter
      )
    );

    res.status(429).json({
      ok: false,

      error:
        "طلبات كثيرة خلال وقت قصير، حاول بعد قليل"
    });

    return false;
  }

  return true;
}


// ==================================================
// التحقق من الأرقام
// ==================================================

function onlyDigits(value) {
  return /^\d+$/.test(
    String(
      value ||
      ""
    ).trim()
  );
}


function isPossibleSearchNumber(
  value
) {
  const v =
    String(
      value ||
      ""
    ).trim();

  return (
    onlyDigits(v) &&
    v.length >= 6 &&
    v.length <= 30
  );
}


function isPossibleOrderNumber(
  value
) {
  const v =
    String(
      value ||
      ""
    ).trim();

  return (
    onlyDigits(v) &&
    v.length >= 6 &&
    v.length <= 15
  );
}


function isPossibleTrackingNumber(
  value
) {
  const v =
    String(
      value ||
      ""
    ).trim();

  return (
    onlyDigits(v) &&
    v.length >= 8 &&
    v.length <= 30
  );
}


// ==================================================
// الصاعدي
// ==================================================

function buildSaeediResponse(
  query,
  salla,
  stage
) {
  const shipped =
    stage >= 3;

  return {
    ok: true,

    source:
      "salla-saeedi",

    inputType:
      "order",

    orderId:
      salla.orderNumber ||
      query,

    stage,

    ...uiForStage(
      stage
    ),

    rawStatus:
      salla.status,

    deliveryCompany:
      "الصاعدي",

    trackingNumber:
      "",

    trackingUrl:
      "",

    shipmentId:
      "",

    packageCount:
      null,

    date:
      salla.date ||
      "",

    history:
      [],

    isSaeedi:
      true,

    specialMessage:
      shipped
        ? "تم شحن طلبك مع الصاعدي، والتوصيل خلال 3 أيام عمل كحد أقصى."
        : "",

    carrierPhone:
      shipped
        ? "0566276686"
        : "",

    carrierLocation:
      shipped
        ? "https://maps.app.goo.gl/koJSu6bHMWpANMWe6"
        : ""
  };
}


// ==================================================
// الحالات
// ==================================================

function normalize(value) {
  return String(
    value ||
    ""
  )
    .toLowerCase()
    .replace(
      /[أإآ]/g,
      "ا"
    )
    .replace(
      /ى/g,
      "ي"
    )
    .replace(
      /ة/g,
      "ه"
    )
    .replace(
      /[ًٌٍَُِّْـ]/g,
      ""
    )
    .replace(
      /[_-]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function classifySallaStatus(
  status
) {
  const s =
    normalize(
      status
    );

  if (
    /تم التسليم|تم التوصيل|مكتمل|delivered|completed|complete/.test(
      s
    )
  ) {
    return 4;
  }

  if (
    /تم الشحن|تم شحن|مشحون|جاري التوصيل|قيد التوصيل|خرج للتسليم|خرجت للتسليم|في الطريق|shipped|shipping|in.?transit|transit|out.?for.?delivery/.test(
      s
    )
  ) {
    return 3;
  }

  if (
    /جاري التجهيز|قيد التجهيز|تم التنفيذ|جاهز للشحن|بانتظار الشحن|انتظار الشحن|processing|preparing|ready|packed|packing/.test(
      s
    )
  ) {
    return 2;
  }

  return 1;
}


function classifyOtoStatus(
  status,
  dcStatus
) {
  const s =
    normalize(
      `${status || ""} ${dcStatus || ""}`
    );

  if (
    /delivered|completed|complete|تم التسليم|تم التوصيل/.test(
      s
    )
  ) {
    return 4;
  }

  if (
    isCarrierEvent(
      s
    )
  ) {
    return 3;
  }

  if (
    /processing|preparing|ready|packed|packing|warehouse|جاري التجهيز/.test(
      s
    )
  ) {
    return 2;
  }

  return 1;
}


function classifyTrackingStage(
  shipment
) {
  const history =
    Array.isArray(
      shipment?.history
    )
      ? shipment.history
      : [];

  const latest =
    history[0] ||
    null;

  const currentText =
    latest
      ? `${latest.status || ""} ${latest.dcStatus || ""} ${latest.description || ""}`
      : `${shipment?.otoStatus || ""} ${shipment?.dcStatus || ""}`;

  return isConfirmedDeliveredText(
    currentText
  )
    ? 4
    : 3;
}


function isConfirmedDeliveredText(
  value
) {
  const s =
    normalize(
      value
    );

  if (
    /on hold|attempting to contact|cannot be reached|mobile cannot be reached|delivery scheduled|scheduled|delivery exception|undeliverable|تعذر.*التواصل|محاوله.*التواصل|معلق/.test(
      s
    )
  ) {
    return false;
  }

  return (
    /(^|\s)delivered(\s|$)/.test(
      s
    ) ||
    /(^|\s)completed(\s|$)/.test(
      s
    ) ||
    /تم التسليم|تم التوصيل/.test(
      s
    )
  );
}


function uiForStage(stage) {
  if (
    stage === 4
  ) {
    return {
      displayStatus:
        "تم التسليم",

      scene:
        "delivered",

      sceneTitle:
        "تم تسليم طلبك",

      sceneText:
        "تم تسجيل الطلب كمُسلّم بنجاح."
    };
  }

  if (
    stage === 3
  ) {
    return {
      displayStatus:
        "تم الشحن",

      scene:
        "shipped",

      sceneTitle:
        "شحنتك في الطريق",

      sceneText:
        "تم تسليم طلبك لشركة الشحن وهو مستمر في مسار التوصيل."
    };
  }

  if (
    stage === 2
  ) {
    return {
      displayStatus:
        "جاري التجهيز",

      scene:
        "preparing",

      sceneTitle:
        "طلبك قيد التجهيز",

      sceneText:
        "يتم الآن تجهيز طلبك وتغليفه تمهيدًا للشحن."
    };
  }

  return {
    displayStatus:
      "تم استلام الطلب",

    scene:
      "received",

    sceneTitle:
      "تم استلام طلبك",

    sceneText:
      "تم تسجيل طلبك بنجاح وهو الآن قيد المراجعة."
  };
}


// ==================================================
// سلة / Google Apps Script
// ==================================================

async function getSallaOrder(
  orderId
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      10000
    );

  try {
    const response =
      await fetch(
        `${SALLA_TRACKING_URL}?order=${encodeURIComponent(orderId)}&_=${Date.now()}`,
        {
          method:
            "GET",

          redirect:
            "follow",

          cache:
            "no-store",

          headers: {
            Accept:
              "application/json,text/plain,*/*"
          },

          signal:
            controller.signal
        }
      );

    if (
      !response.ok
    ) {
      return {
        type:
          "error"
      };
    }

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(
          text
        );

    } catch {
      return {
        type:
          "error"
      };
    }

    if (
      data?.ok === false &&
      data?.error ===
        "ORDER_NOT_FOUND"
    ) {
      return {
        type:
          "not_found"
      };
    }

    if (
      !data?.ok ||
      !data?.order
    ) {
      return {
        type:
          "error"
      };
    }

    const returnedOrderNumber =
      String(
        data.order.orderNumber ||
        ""
      ).trim();

    if (
      returnedOrderNumber &&
      returnedOrderNumber !==
        String(
          orderId
        )
    ) {
      return {
        type:
          "not_found"
      };
    }

    return {
      type:
        "found",

      order: {
        orderNumber:
          returnedOrderNumber ||
          String(
            orderId
          ),

        status:
          String(
            data.order.status ||
            ""
          ).trim(),

        date:
          String(
            data.order.date ||
            ""
          ).trim(),

        shippingCompany:
          String(
            data.order.shippingCompany ||
            ""
          ).trim()
      }
    };

  } catch {
    return {
      type:
        "error"
    };

  } finally {
    clearTimeout(
      timer
    );
  }
}


// ==================================================
// OTO token
// ==================================================

async function getAccessToken() {
  const refreshToken =
    process.env
      .OTO_REFRESH_TOKEN;

  if (
    !refreshToken
  ) {
    return null;
  }

  try {
    const response =
      await fetch(
        "https://api.tryoto.com/rest/v2/refreshToken",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",

            Accept:
              "application/json"
          },

          body:
            JSON.stringify({
              refresh_token:
                refreshToken
            })
        }
      );

    const data =
      await safeJson(
        response
      );

    if (
      !response.ok
    ) {
      return null;
    }

    return (
      data?.access_token ||
      data?.accessToken ||
      data?.token ||
      null
    );

  } catch {
    return null;
  }
}


// ==================================================
// OTO برقم الطلب
// ==================================================

async function getOtoOrder(
  orderId,
  accessToken
) {
  try {
    const headers = {
      "Content-Type":
        "application/json",

      Accept:
        "application/json",

      Authorization:
        `Bearer ${accessToken}`
    };

    const statusResponse =
      await fetch(
        "https://api.tryoto.com/rest/v2/orderStatus",
        {
          method:
            "POST",

          headers,

          body:
            JSON.stringify({
              orderId
            })
        }
      );

    const statusData =
      await safeJson(
        statusResponse
      );

    if (
      !statusResponse.ok ||
      statusData?.success ===
        false
    ) {
      return null;
    }

    let detailsData =
      {};

    try {
      const detailsResponse =
        await fetch(
          `https://api.tryoto.com/rest/v2/orderDetails?orderId=${encodeURIComponent(orderId)}`,
          {
            method:
              "GET",

            headers
          }
        );

      detailsData =
        await safeJson(
          detailsResponse
        );

    } catch {}

    const returnedOrderId =
      firstValue(
        detailsData,
        [
          "orderId",
          "orderNumber",
          "orderReference",
          "orderReferenceId"
        ]
      ) ||
      firstValue(
        statusData,
        [
          "orderId",
          "orderNumber",
          "orderReference",
          "orderReferenceId"
        ]
      );

    if (
      returnedOrderId &&
      normalizeId(
        returnedOrderId
      ) !==
        normalizeId(
          orderId
        )
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

    const shipmentId =
      firstValue(
        statusData,
        [
          "shipmentId",
          "awbNumber"
        ]
      ) ||
      firstValue(
        detailsData,
        [
          "shipmentId",
          "awbNumber"
        ]
      );

    let trackingNumber =
      firstValue(
        statusData,
        [
          "dcTrackingNumber",
          "trackingNumber"
        ]
      ) ||
      firstValue(
        detailsData,
        [
          "dcTrackingNumber",
          "trackingNumber"
        ]
      );

    if (
      !trackingNumber &&
      isPossibleTrackingNumber(
        shipmentId
      )
    ) {
      trackingNumber =
        String(
          shipmentId
        );
    }

    const deliveryCompany =
      firstValue(
        statusData,
        [
          "deliveryCompany",
          "deliveryCompanyName",
          "carrier"
        ]
      ) ||
      firstValue(
        detailsData,
        [
          "deliveryCompany",
          "deliveryCompanyName",
          "carrier"
        ]
      );

    const trackingUrl =
      firstValue(
        statusData,
        [
          "trackingUrl",
          "trackingURL"
        ]
      ) ||
      firstValue(
        detailsData,
        [
          "trackingUrl",
          "trackingURL"
        ]
      );

    if (
      !trackingNumber &&
      trackingUrl
    ) {
      const fromUrl =
        extractTrackingFromUrl(
          trackingUrl
        );

      if (
        isPossibleTrackingNumber(
          fromUrl
        )
      ) {
        trackingNumber =
          fromUrl;
      }
    }

    const hasRealData =
      Boolean(
        status ||
        dcStatus ||
        trackingNumber ||
        shipmentId ||
        deliveryCompany ||
        returnedOrderId
      );

    if (
      !hasRealData
    ) {
      return null;
    }

    let historyData =
      {};

    try {
      const historyResponse =
        await fetch(
          "https://api.tryoto.com/rest/v2/orderHistory",
          {
            method:
              "POST",

            headers,

            body:
              JSON.stringify({
                orderIds: [
                  orderId
                ]
              })
          }
        );

      historyData =
        await safeJson(
          historyResponse
        );

    } catch {}

    return {
      status,

      dcStatus,

      deliveryCompany,

      trackingNumber,

      trackingUrl,

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


function extractTrackingFromUrl(
  url
) {
  try {
    const match =
      String(
        url ||
        ""
      ).match(
        /(?:ShipmentNumber|trackingNumber|awb)=([0-9]{8,30})/i
      );

    return match
      ? match[1]
      : "";

  } catch {
    return "";
  }
}


// ==================================================
// OTO برقم التتبع
// ==================================================

async function trackShipment(
  trackingNumber,
  deliveryCompanyName,
  accessToken
) {
  const requestedTracking =
    String(
      trackingNumber ||
      ""
    ).trim();

  if (
    !isPossibleTrackingNumber(
      requestedTracking
    )
  ) {
    return null;
  }

  try {
    const response =
      await fetch(
        "https://api.tryoto.com/rest/v2/trackShipment",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",

            Accept:
              "application/json",

            Authorization:
              `Bearer ${accessToken}`
          },

          body:
            JSON.stringify({
              trackingNumber:
                requestedTracking,

              deliveryCompanyName,

              statusHistory:
                true
            })
        }
      );

    const data =
      await safeJson(
        response
      );

    if (
      !response.ok ||
      data?.success ===
        false
    ) {
      return null;
    }

    const items =
      Array.isArray(
        data?.items
      )
        ? data.items
        : [];

    if (
      !items.length
    ) {
      return null;
    }

    const normalizedItems =
      items
        .map(
          item => ({
            status:
              String(
                item?.otoStatus ||
                item?.status ||
                item?.dcStatus ||
                ""
              ),

            dcStatus:
              String(
                item?.dcStatus ||
                ""
              ),

            date:
              String(
                item?.dcUpdateDate ||
                item?.updateDate ||
                item?.date ||
                ""
              ),

            description:
              redactPII(
                String(
                  item?.dcDescription ||
                  item?.description ||
                  ""
                )
              ),

            shipmentId:
              String(
                item?.shipmentId ||
                ""
              ),

            trackingNumber:
              String(
                item?.trackingNumber ||
                item?.dcTrackingNumber ||
                item?.shipmentId ||
                ""
              )
          })
        )
        .filter(
          item =>
            item.status ||
            item.dcStatus ||
            item.description ||
            item.shipmentId
        );

    if (
      !normalizedItems.length
    ) {
      return null;
    }

    const returnedNumbers =
      normalizedItems
        .map(
          item =>
            String(
              item.trackingNumber ||
              ""
            ).trim()
        )
        .filter(
          isPossibleTrackingNumber
        );

    if (
      returnedNumbers.length &&
      !returnedNumbers.includes(
        requestedTracking
      )
    ) {
      return null;
    }

    normalizedItems.sort(
      (
        a,
        b
      ) => {
        const da =
          new Date(
            a.date
          ).getTime();

        const db =
          new Date(
            b.date
          ).getTime();

        if (
          Number.isNaN(
            da
          ) ||
          Number.isNaN(
            db
          )
        ) {
          return 0;
        }

        return (
          db -
          da
        );
      }
    );

    const nestedHistory =
      normalizeHistory(
        data
      ).map(
        item => ({
          status:
            String(
              item?.status ||
              ""
            ),

          dcStatus:
            String(
              item?.dcStatus ||
              ""
            ),

          date:
            String(
              item?.date ||
              ""
            ),

          description:
            redactPII(
              String(
                item?.description ||
                ""
              )
            ),

          shipmentId:
            "",

          trackingNumber:
            requestedTracking
        })
      );

    const carrierHistory =
      mergeHistories(
        [
          ...normalizedItems,
          ...nestedHistory
        ],

        []
      );

    const current =
      carrierHistory[0] ||
      normalizedItems[0] ||
      {};

    return {
      trackingNumber:
        requestedTracking,

      deliveryCompany:
        deliveryCompanyName,

      trackingUrl:
        String(
          data?.trackingUrl ||
          ""
        ),

      shipmentId:
        current.shipmentId ||
        requestedTracking,

      otoStatus:
        current.status ||
        "",

      dcStatus:
        current.dcStatus ||
        "",

      date:
        current.date ||
        "",

      history:
        carrierHistory
    };

  } catch {
    return null;
  }
}


// ==================================================
// سجل الشحن
// ==================================================

function buildCarrierHistory(
  oto
) {
  if (
    !oto
  ) {
    return [];
  }

  const events =
    Array.isArray(
      oto.history
    )
      ? [
          ...oto.history
        ]
      : [];

  if (
    isCarrierEvent(
      `${oto.dcStatus || ""} ${oto.status || ""}`
    )
  ) {
    events.unshift({
      status:
        oto.dcStatus ||
        oto.status ||
        "",

      dcStatus:
        oto.dcStatus ||
        "",

      date:
        oto.date ||
        "",

      description:
        ""
    });
  }

  return events.filter(
    item => {
      const combined =
        `${item?.status || ""} ${item?.dcStatus || ""} ${item?.description || ""}`;

      if (
        isInternalOtoEvent(
          combined
        )
      ) {
        return false;
      }

      return isCarrierEvent(
        combined
      );
    }
  );
}


function mergeHistories(
  shipmentHistory,
  otoHistory
) {
  const combined = [
    ...(
      Array.isArray(
        shipmentHistory
      )
        ? shipmentHistory
        : []
    ),

    ...(
      Array.isArray(
        otoHistory
      )
        ? otoHistory
        : []
    )
  ];

  combined.sort(
    (
      a,
      b
    ) => {
      const da =
        new Date(
          a?.date ||
          a?.dcUpdateDate ||
          a?.updateDate ||
          0
        ).getTime();

      const db =
        new Date(
          b?.date ||
          b?.dcUpdateDate ||
          b?.updateDate ||
          0
        ).getTime();

      return (
        db -
        da
      );
    }
  );

  const seen =
    new Set();

  const result =
    [];

  for (
    const item
    of combined
  ) {
    if (
      !item
    ) {
      continue;
    }

    const rawStatus =
      String(
        item.status ||
        item.otoStatus ||
        item.dcStatus ||
        ""
      ).trim();

    const rawDcStatus =
      String(
        item.dcStatus ||
        ""
      ).trim();

    const date =
      String(
        item.date ||
        item.dcUpdateDate ||
        item.updateDate ||
        ""
      ).trim();

    const description =
      redactPII(
        String(
          item.description ||
          item.dcDescription ||
          ""
        )
      );

    if (
      !rawStatus &&
      !rawDcStatus &&
      !description
    ) {
      continue;
    }

    const combinedText =
      `${rawStatus} ${rawDcStatus} ${description}`;

    if (
      isInternalOtoEvent(
        combinedText
      )
    ) {
      continue;
    }

    const status =
      friendlyAramexStatus(
        rawStatus,
        rawDcStatus,
        description
      );

    const dcStatus =
      /^sh\d+$/i.test(
        rawDcStatus
      )
        ? ""
        : rawDcStatus;

    const descriptionKey =
      normalize(
        description
      );

    const key =
      descriptionKey
        ? `desc:${descriptionKey}`
        : `status:${normalize(status)}`;

    if (
      seen.has(
        key
      )
    ) {
      continue;
    }

    seen.add(
      key
    );

    result.push({
      status,

      dcStatus,

      date,

      description:
        friendlyAramexDescription(
          rawStatus,
          rawDcStatus,
          description
        ),

      shipmentId:
        String(
          item.shipmentId ||
          ""
        ),

      trackingNumber:
        String(
          item.trackingNumber ||
          ""
        )
    });
  }

  return result.slice(
    0,
    30
  );
}


// ==================================================
// ترجمة أرامكس
// ==================================================

function friendlyAramexStatus(
  status,
  dcStatus,
  description
) {
  const text =
    normalize(
      `${status || ""} ${dcStatus || ""} ${description || ""}`
    );

  if (
    /on hold|attempting to contact|cannot be reached|mobile cannot be reached/.test(
      text
    )
  ) {
    return "تعذر التواصل مع العميل";
  }

  if (
    /delivery scheduled/.test(
      text
    )
  ) {
    return "تم تحديد موعد للتسليم";
  }

  if (
    /sms sent to consignee/.test(
      text
    )
  ) {
    return "تم إشعار المستلم";
  }

  if (
    /record created/.test(
      text
    )
  ) {
    return "تم إنشاء الشحنة";
  }

  if (
    /received at origin facility/.test(
      text
    )
  ) {
    return "تم استلام الشحنة في مركز الانطلاق";
  }

  if (
    /out for delivery|out.?for.?delivery|with courier/.test(
      text
    )
  ) {
    return "خرجت الشحنة للتسليم";
  }

  if (
    /under processing at operations facility|processing at operations facility/.test(
      text
    )
  ) {
    return "الشحنة قيد المعالجة لدى أرامكس";
  }

  if (
    /departed operations facility/.test(
      text
    ) ||
    (
      /departed/.test(
        text
      ) &&
      /in transit/.test(
        text
      )
    )
  ) {
    return "الشحنة في الطريق";
  }

  if (
    /arrived destination terminal|arrived.?terminal|arrived.?hub|arrived.?facility/.test(
      text
    )
  ) {
    return "وصلت إلى محطة شركة الشحن";
  }

  if (
    /departed.?terminal|departed.?hub|departed.?facility/.test(
      text
    )
  ) {
    return "غادرت محطة شركة الشحن";
  }

  if (
    isConfirmedDeliveredText(
      text
    )
  ) {
    return "تم تسليم الشحنة";
  }

  const rawStatus =
    String(
      status ||
      ""
    ).trim();

  if (
    /^sh\d+$/i.test(
      rawStatus
    ) ||
    /[a-z]/i.test(
      rawStatus
    )
  ) {
    return "تحديث من شركة الشحن";
  }

  return (
    rawStatus ||
    "تحديث من شركة الشحن"
  );
}


function friendlyAramexDescription(
  status,
  dcStatus,
  description
) {
  const raw =
    String(
      description ||
      ""
    ).trim();

  const text =
    normalize(
      `${status || ""} ${dcStatus || ""} ${raw}`
    );

  if (
    /on hold|attempting to contact|mobile cannot be reached|cannot be reached|customer not reachable/.test(
      text
    )
  ) {
    return "تعذر التواصل مع العميل، والشحنة معلقة مؤقتًا";
  }

  if (
    /under processing at operations facility|processing at operations facility/.test(
      text
    )
  ) {
    return "الشحنة قيد المعالجة في مركز عمليات أرامكس";
  }

  if (
    /departed operations facility/.test(
      text
    ) ||
    (
      /departed/.test(
        text
      ) &&
      /in transit/.test(
        text
      )
    )
  ) {
    return "غادرت الشحنة مركز العمليات وهي في الطريق";
  }

  if (
    /delivery scheduled/.test(
      text
    )
  ) {
    return "تم تحديد موعد لتسليم الشحنة";
  }

  if (
    /sms sent to consignee/.test(
      text
    )
  ) {
    return "تم إرسال رسالة نصية إلى المستلم";
  }

  if (
    /received at origin facility/.test(
      text
    )
  ) {
    return "تم استلام الشحنة في مركز الانطلاق";
  }

  if (
    /record created/.test(
      text
    )
  ) {
    return "تم إنشاء سجل الشحنة لدى شركة الشحن";
  }

  if (
    /out for delivery|with courier/.test(
      text
    )
  ) {
    return "الشحنة مع المندوب وفي طريقها للتسليم";
  }

  if (
    /arrived at destination|arrived destination|received at destination facility/.test(
      text
    )
  ) {
    return "وصلت الشحنة إلى مركز شركة الشحن في مدينة الوجهة";
  }

  if (
    /picked up|shipment picked up|received by carrier|carrier received|accepted by carrier/.test(
      text
    )
  ) {
    return "تم استلام الشحنة من المرسل";
  }

  if (
    isConfirmedDeliveredText(
      text
    )
  ) {
    return "تم تسليم الشحنة بنجاح";
  }

  if (
    /in transit/.test(
      text
    )
  ) {
    return "الشحنة في الطريق إلى وجهتها";
  }

  return "";
}


// ==================================================
// فلترة أحداث الشحن
// ==================================================

function isCarrierEvent(value) {
  const s =
    normalize(
      value
    );

  return (
    /picked.?up|pickup|collected/.test(
      s
    ) ||

    /received.?by.?carrier|carrier.?received|accepted.?by.?carrier/.test(
      s
    ) ||

    /arrived.?terminal|departed.?terminal/.test(
      s
    ) ||

    /arrived.?destination.?terminal|departed.?destination.?terminal/.test(
      s
    ) ||

    /arrived.?origin.?terminal|departed.?origin.?terminal/.test(
      s
    ) ||

    /arrived.?hub|departed.?hub/.test(
      s
    ) ||

    /arrived.?facility|departed.?facility/.test(
      s
    ) ||

    /under processing at operations facility/.test(
      s
    ) ||

    /in.?transit|\btransit\b|departed|moving|forwarded/.test(
      s
    ) ||

    /with.?courier|out.?for.?delivery/.test(
      s
    ) ||

    /delivery scheduled/.test(
      s
    ) ||

    /sms sent to consignee/.test(
      s
    ) ||

    /record created/.test(
      s
    ) ||

    /delivery.?attempt|attempted.?delivery/.test(
      s
    ) ||

    /delivered/.test(
      s
    ) ||

    /returned|return.?to.?sender/.test(
      s
    ) ||

    /delivery.?exception|undeliverable|on.?hold/.test(
      s
    ) ||

    /استلمت.*شركه.*الشحن/.test(
      s
    ) ||

    /استلام.*شركه.*الشحن/.test(
      s
    ) ||

    /استلم.*الناقل/.test(
      s
    ) ||

    /تم.*استلام.*الشحنه/.test(
      s
    ) ||

    /وصلت.*محطه|وصلت.*الفرع|وصلت.*مركز/.test(
      s
    ) ||

    /غادرت.*المحطه|غادرت.*الفرع|غادرت.*المركز/.test(
      s
    ) ||

    /في.*الطريق|جاري.*التوصيل|خرجت.*للتسليم/.test(
      s
    ) ||

    /محاوله.*تسليم|تم.*التسليم/.test(
      s
    )
  );
}


function isInternalOtoEvent(
  value
) {
  const s =
    normalize(
      value
    );

  return (
    /تم تحديث|تم تعديل/.test(
      s
    ) ||

    /موقع الارسال|العنوان|المرسل/.test(
      s
    ) ||

    /sender|address/.test(
      s
    ) ||

    /location updated|edited|changed/.test(
      s
    ) ||

    /order created/.test(
      s
    ) ||

    /warehouse|packing|preparing/.test(
      s
    )
  );
}


// ==================================================
// شركات الشحن
// ==================================================

function isSaeedi(
  company
) {
  return /الصاعدي|alsaedi|al saeedi|al-saeedi|saeedi/.test(
    normalize(
      company
    )
  );
}


function cleanSallaCarrier(
  company
) {
  const c =
    String(
      company ||
      ""
    ).trim();

  if (
    /^oto$/i.test(
      c
    ) ||
    /بوابه الشحن|بوابة الشحن/i.test(
      c
    )
  ) {
    return "";
  }

  return c;
}


function normalizeCarrierName(
  company
) {
  const c =
    String(
      company ||
      ""
    ).trim();

  if (
    !c
  ) {
    return "";
  }

  const n =
    normalize(
      c
    );

  if (
    /aramex|ارامكس/.test(
      n
    )
  ) {
    return "Aramex";
  }

  if (
    isSaeedi(
      c
    )
  ) {
    return "الصاعدي";
  }

  if (
    /^oto$|بوابه الشحن/.test(
      n
    )
  ) {
    return "";
  }

  return c;
}


function carrierCodeFromName(
  company
) {
  const n =
    normalize(
      company
    );

  if (
    /aramex|ارامكس/.test(
      n
    )
  ) {
    return "aramex";
  }

  return "";
}


// ==================================================
// أدوات عامة
// ==================================================

function normalizeId(
  value
) {
  return String(
    value ||
    ""
  )
    .trim()
    .replace(
      /\s+/g,
      ""
    );
}


async function safeJson(
  response
) {
  try {
    return await response.json();

  } catch {
    return {};
  }
}


function firstValue(
  obj,
  keys
) {
  for (
    const key
    of keys
  ) {
    const value =
      findField(
        obj,
        key
      );

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return String(
        value
      );
    }
  }

  return "";
}


function findField(
  value,
  key
) {
  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return undefined;
  }

  if (
    Object.prototype
      .hasOwnProperty
      .call(
        value,
        key
      )
  ) {
    return value[key];
  }

  for (
    const child
    of Object.values(
      value
    )
  ) {
    if (
      child &&
      typeof child ===
        "object"
    ) {
      const found =
        findField(
          child,
          key
        );

      if (
        found !==
        undefined
      ) {
        return found;
      }
    }
  }

  return undefined;
}


function findNumericField(
  obj,
  key
) {
  const value =
    findField(
      obj,
      key
    );

  if (
    value ===
      undefined ||
    value ===
      null ||
    value ===
      ""
  ) {
    return null;
  }

  const number =
    Number(
      value
    );

  return Number.isFinite(
    number
  )
    ? number
    : null;
}


function normalizeHistory(
  raw
) {
  const arrays =
    [];

  collectArrays(
    raw,
    arrays
  );

  const list =
    arrays
      .sort(
        (
          a,
          b
        ) =>
          b.length -
          a.length
      )[0] ||
    [];

  return list
    .map(
      item => {
        if (
          !item ||
          typeof item !==
            "object"
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
              "action",
              "otoStatus"
            ]
          );

        const dcStatus =
          pick(
            item,
            [
              "dcStatus"
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
              "updateDate",
              "dcUpdateDate"
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
              status ||
              ""
            ),

          dcStatus:
            String(
              dcStatus ||
              ""
            ),

          date:
            String(
              date ||
              ""
            ),

          description
        };
      }
    )
    .filter(
      Boolean
    )
    .slice(
      0,
      60
    );
}


function collectArrays(
  value,
  arrays
) {
  if (
    !value
  ) {
    return;
  }

  if (
    Array.isArray(
      value
    )
  ) {
    if (
      value.length &&
      value.some(
        x =>
          x &&
          typeof x ===
            "object"
      )
    ) {
      arrays.push(
        value
      );
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
    typeof value ===
      "object"
  ) {
    Object.values(
      value
    ).forEach(
      x =>
        collectArrays(
          x,
          arrays
        )
    );
  }
}


function pick(
  obj,
  keys
) {
  for (
    const key
    of keys
  ) {
    if (
      obj?.[key] !==
        undefined &&
      obj?.[key] !==
        null &&
      obj?.[key] !==
        ""
    ) {
      return obj[key];
    }
  }

  return "";
}


function redactPII(
  value
) {
  let text =
    String(
      value ||
      ""
    );

  text =
    text.replace(
      /\b(?:\+?966|0)?5\d{8}\b/g,
      ""
    );

  text =
    text.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      ""
    );

  text =
    text.replace(
      /\b\d{9,16}\b/g,
      ""
    );

  return text
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .slice(
      0,
      220
    );
}
