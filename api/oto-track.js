const SALLA_TRACKING_URL =
  "https://script.google.com/macros/s/AKfycbwtcuRqFEGX3rJ1o0yN_T2i8V51le5U4aJte5xnvfNAQILRtyqvNVojT4YMDop-hDr_/exec";

export default async function handler(req, res) {
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

    // ==========================================
    // 1) نبحث في سلة أولاً
    // ==========================================
    const sallaResult = await getSallaOrder(query);

    if (sallaResult.type === "error") {
      return res.status(503).json({
        ok: false,
        error: "تعذر قراءة حالة الطلب من سلة حالياً، حاول مرة أخرى"
      });
    }

    if (sallaResult.type === "found") {
      const salla = sallaResult.order;
      const stage = classifySallaStatus(salla.status);

      // ==========================================
      // الصاعدي - سلة فقط
      // ==========================================
      if (isSaeedi(salla.shippingCompany)) {
        return res.status(200).json(
          buildSaeediResponse(query, salla, stage)
        );
      }

      // إذا سلة تقول أن الطلب لم يدخل الشحن
      // لا نخلي وجود بوليصة OTO يحوله للشحن
      if (stage < 3) {
        return res.status(200).json({
          ok: true,
          source: "salla",
          inputType: "order",

          orderId:
            salla.orderNumber || query,

          stage,
          ...uiForStage(stage),

          rawStatus:
            salla.status,

          deliveryCompany: "",
          trackingNumber: "",
          trackingUrl: "",
          shipmentId: "",

          packageCount: null,

          date:
            salla.date || "",

          history: [],

          isSaeedi: false
        });
      }

      // ==========================================
      // سلة تقول تم الشحن
      // نقرأ OTO برقم الطلب
      // ==========================================
      const oto = token
        ? await getOtoOrder(
            salla.orderNumber || query,
            token
          )
        : null;

      const trackingNumber =
        oto?.trackingNumber || "";

      const carrierCode =
        carrierCodeFromName(
          oto?.deliveryCompany ||
          salla.shippingCompany
        );

      let shipment = null;

      // إذا حصلنا على رقم تتبع
      // نكمل القراءة عليه
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

      return res.status(200).json({
        ok: true,

        source:
          shipment
            ? "salla+tracking"
            : oto
              ? "salla+oto"
              : "salla",

        inputType: "order",

        orderId:
          salla.orderNumber || query,

        // حالة الطلب الأساسية تبقى من سلة
        stage,
        ...uiForStage(stage),

        rawStatus:
          salla.status,

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
          oto?.packageCount ?? null,

        date:
          shipment?.date ||
          oto?.date ||
          salla.date ||
          "",

        history:
          shipment
            ? shipment.history
            : buildCarrierHistory(oto),

        isSaeedi: false
      });
    }

    // ==========================================
    // 2) غير موجود في سلة
    // نجرب رقم طلب قديم في OTO
    // ==========================================
    if (
      token &&
      isPossibleOrderNumber(query)
    ) {
      const oto = await getOtoOrder(
        query,
        token
      );

      if (oto) {
        const stage =
          classifyOtoStatus(
            oto.status,
            oto.dcStatus
          );

        const carrierCode =
          carrierCodeFromName(
            oto.deliveryCompany
          );

        let shipment = null;

        if (
          oto.trackingNumber &&
          carrierCode &&
          isPossibleTrackingNumber(
            oto.trackingNumber
          )
        ) {
          shipment = await trackShipment(
            oto.trackingNumber,
            carrierCode,
            token
          );
        }

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
          ...uiForStage(stage),

          rawStatus:
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
            oto.packageCount ?? null,

          date:
            shipment?.date ||
            oto.date ||
            "",

          history:
            shipment
              ? shipment.history
              : stage >= 3
                ? buildCarrierHistory(oto)
                : [],

          isSaeedi:
            false
        });
      }
    }

    // ==========================================
    // 3) نجربه كرقم تتبع أرامكس
    // ==========================================
    if (
      token &&
      isPossibleTrackingNumber(query)
    ) {
      const directShipment =
        await trackShipment(
          query,
          "aramex",
          token
        );

      if (directShipment) {
        const stage =
          classifyTrackingStage(
            directShipment
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
          ...uiForStage(stage),

          rawStatus:
            directShipment.otoStatus ||
            directShipment.dcStatus ||
            "",

          deliveryCompany:
            "Aramex",

          trackingNumber:
            directShipment.trackingNumber ||
            query,

          trackingUrl:
            directShipment.trackingUrl ||
            "",

          shipmentId:
            directShipment.shipmentId ||
            "",

          packageCount:
            null,

          date:
            directShipment.date ||
            "",

          history:
            directShipment.history ||
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
// التحقق من الرقم
// ==================================================

function onlyDigits(value) {
  return /^\d+$/.test(
    String(value || "").trim()
  );
}


function isPossibleSearchNumber(value) {
  const v =
    String(value || "").trim();

  return (
    onlyDigits(v) &&
    v.length >= 6 &&
    v.length <= 30
  );
}


function isPossibleOrderNumber(value) {
  const v =
    String(value || "").trim();

  return (
    onlyDigits(v) &&
    v.length >= 6 &&
    v.length <= 15
  );
}


function isPossibleTrackingNumber(value) {
  const v =
    String(value || "").trim();

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

    ...uiForStage(stage),

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
      salla.date || "",

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
        ? "https://maps.app.goo.gl/NNJ3VgvtCKpaJKkcA"
        : ""
  };
}


// ==================================================
// تنظيف النص
// ==================================================

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


// ==================================================
// حالات سلة
// ==================================================

function classifySallaStatus(status) {
  const s =
    normalize(status);

  if (
    /تم التسليم|تم التوصيل|مكتمل|delivered|completed|complete/.test(s)
  ) {
    return 4;
  }

  if (
    /تم الشحن|تم شحن|مشحون|جاري التوصيل|قيد التوصيل|خرج للتسليم|خرجت للتسليم|في الطريق|shipped|shipping|in.?transit|transit|out.?for.?delivery/.test(s)
  ) {
    return 3;
  }

  if (
    /جاري التجهيز|قيد التجهيز|تم التنفيذ|جاهز للشحن|بانتظار الشحن|انتظار الشحن|processing|preparing|ready|packed|packing/.test(s)
  ) {
    return 2;
  }

  return 1;
}


// ==================================================
// حالات OTO
// ==================================================

function classifyOtoStatus(
  status,
  dcStatus
) {
  const s =
    normalize(
      `${status || ""} ${dcStatus || ""}`
    );

  // تم التسليم
  if (
    /delivered|completed|complete|تم التسليم|تم التوصيل/.test(s)
  ) {
    return 4;
  }

  // ==========================================
  // كل الحالات الفعلية بعد استلام الناقل للشحنة
  // ==========================================
  if (
    /out.?for.?delivery|shipped|shipping|in.?transit|transit|arrived.?terminal|departed.?terminal|arrived.?hub|departed.?hub|picked.?up|pickup|collected|dispatch|departed|تم الشحن|جاري التوصيل/.test(s)
  ) {
    return 3;
  }

  // تجهيز
  if (
    /processing|preparing|ready|packed|packing|warehouse|جاري التجهيز/.test(s)
  ) {
    return 2;
  }

  return 1;
}


// ==================================================
// البحث المباشر برقم التتبع
// ==================================================

function classifyTrackingStage(
  shipment
) {
  const combined =
    normalize(
      `${shipment?.otoStatus || ""}
       ${shipment?.dcStatus || ""}
       ${(shipment?.history || [])
         .map(
           x =>
             `${x.status || ""} ${x.description || ""}`
         )
         .join(" ")}`
    );

  if (
    /delivered|completed|تم التسليم|تم التوصيل/.test(combined)
  ) {
    return 4;
  }

  // بما أننا حصلنا على شحنة فعلية من trackShipment
  return 3;
}


// ==================================================
// نصوص الواجهة
// ==================================================

function uiForStage(stage) {
  if (stage === 4) {
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

  if (stage === 3) {
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

  if (stage === 2) {
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
// سلة
// ==================================================

async function getSallaOrder(orderId) {
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

    if (!response.ok) {
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
        JSON.parse(text);
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
        String(orderId)
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
          String(orderId),

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
    clearTimeout(timer);
  }
}


// ==================================================
// توكن OTO
// ==================================================

async function getAccessToken() {
  const refreshToken =
    process.env
      .OTO_REFRESH_TOKEN;

  if (!refreshToken) {
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
      await safeJson(response);

    if (!response.ok) {
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
      statusData?.success === false
    ) {
      return null;
    }

    let detailsData = {};

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

    // ==========================================
    // التحقق من رقم الطلب
    // ==========================================

    const returnedOrderId =
      firstValue(
        detailsData,
        [
          "orderId",
          "orderNumber",
          "orderReference"
        ]
      ) ||
      firstValue(
        statusData,
        [
          "orderId",
          "orderNumber",
          "orderReference"
        ]
      );

    if (
      returnedOrderId &&
      String(returnedOrderId) !==
        String(orderId)
    ) {
      return null;
    }

    // ==========================================
    // الحالات
    // ==========================================

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

    // ==========================================
    // shipmentId أولاً
    // ==========================================

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

    // ==========================================
    // trackingNumber
    // ==========================================

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

    // ==========================================
    // الإصلاح المهم:
    // إذا OTO لم يرجع trackingNumber
    // لكن shipmentId نفسه رقم تتبع
    // نستخدمه
    // ==========================================

    if (
      !trackingNumber &&
      isPossibleTrackingNumber(
        shipmentId
      )
    ) {
      trackingNumber =
        String(shipmentId);
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

    // ==========================================
    // رابط التتبع
    // ==========================================

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

    // إذا الرقم ما ظهر في trackingNumber ولا shipmentId
    // نحاول استخراجه من رابط التتبع
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

    if (!hasRealData) {
      return null;
    }

    // ==========================================
    // تاريخ الطلب
    // ==========================================

    let historyData = {};

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
                orderIds:
                  [orderId]
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


// ==================================================
// استخراج رقم التتبع من الرابط
// مثال:
// ShipmentNumber=50875598270
// ==================================================

function extractTrackingFromUrl(url) {
  try {
    const value =
      String(url || "");

    const match =
      value.match(
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
      trackingNumber || ""
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
      data?.success === false
    ) {
      return null;
    }

    const items =
      Array.isArray(
        data?.items
      )
        ? data.items
        : [];

    const returnedTracking =
      firstValue(
        data,
        [
          "trackingNumber",
          "dcTrackingNumber",
          "awbNumber",
          "shipmentId"
        ]
      );

    if (
      returnedTracking &&
      isPossibleTrackingNumber(
        returnedTracking
      ) &&
      String(returnedTracking) !==
        requestedTracking
    ) {
      return null;
    }

    const normalizedItems =
      items
        .map(item => ({
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
        }))
        .filter(item =>
          item.status ||
          item.description ||
          item.shipmentId
        );

    const itemTrackingNumbers =
      normalizedItems
        .map(
          x =>
            String(
              x.trackingNumber ||
              ""
            ).trim()
        )
        .filter(
          x =>
            isPossibleTrackingNumber(x)
        );

    if (
      itemTrackingNumbers.length &&
      !itemTrackingNumbers.includes(
        requestedTracking
      )
    ) {
      return null;
    }

    const hasActualShipment =
      normalizedItems.length > 0 ||
      String(returnedTracking) ===
        requestedTracking;

    if (!hasActualShipment) {
      return null;
    }

    normalizedItems.sort(
      (a, b) => {
        const da =
          new Date(
            a.date
          ).getTime();

        const db =
          new Date(
            b.date
          ).getTime();

        if (
          Number.isNaN(da) ||
          Number.isNaN(db)
        ) {
          return 0;
        }

        return db - da;
      }
    );

    const current =
      normalizedItems[0] ||
      {};

    const carrierHistory =
      normalizedItems.filter(
        item =>
          isCarrierEvent(
            `${item.status} ${item.dcStatus} ${item.description}`
          )
      );

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
// تحديثات شركة الشحن فقط
// ==================================================

function buildCarrierHistory(oto) {
  if (!oto) {
    return [];
  }

  const events =
    Array.isArray(
      oto.history
    )
      ? [...oto.history]
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

      date:
        oto.date ||
        "",

      description:
        ""
    });
  }

  const seen =
    new Set();

  return events
    .filter(item => {
      const combined =
        `${item?.status || ""} ${item?.description || ""}`;

      if (
        isInternalOtoEvent(
          combined
        )
      ) {
        return false;
      }

      if (
        !isCarrierEvent(
          combined
        )
      ) {
        return false;
      }

      const key =
        `${item?.status || ""}|${item?.date || ""}|${item?.description || ""}`;

      if (
        seen.has(key)
      ) {
        return false;
      }

      seen.add(key);

      return true;
    })
    .slice(0, 10);
}


// ==================================================
// أحداث الناقل
// ==================================================

function isCarrierEvent(value) {
  const s =
    normalize(value);

  return /picked.?up|pickup|collected|received.?by.?carrier|carrier.?received|accepted.?by.?carrier|arrived.?terminal|departed.?terminal|arrived.?hub|departed.?hub|departed|in.?transit|transit|out.?for.?delivery|delivery.?attempt|delivered|returned|return.?to.?sender|استلمت.*شركه.*الشحن|استلام.*شركه.*الشحن|استلم.*الناقل|تم.*استلام.*الشحنه|وصلت.*محطه|وصلت.*الفرع|غادرت.*المحطه|غادرت.*الفرع|في.*الطريق|جاري.*التوصيل|خرجت.*للتسليم|تم.*التسليم/.test(s);
}


// ==================================================
// تحديثات OTO الداخلية التي لا نريد عرضها
// ==================================================

function isInternalOtoEvent(value) {
  const s =
    normalize(value);

  return /تم تحديث|تم تعديل|موقع الارسال|العنوان|المرسل|sender|address|location updated|edited|changed|order created|warehouse|packing|preparing/.test(s);
}


// ==================================================
// شركات الشحن
// ==================================================

function isSaeedi(company) {
  return /الصاعدي|alsaedi|al saeedi|al-saeedi|saeedi/.test(
    normalize(company)
  );
}


function cleanSallaCarrier(company) {
  const c =
    String(
      company || ""
    ).trim();

  if (
    /^oto$/i.test(c) ||
    /بوابه الشحن|بوابة الشحن/i.test(c)
  ) {
    return "";
  }

  return c;
}


function normalizeCarrierName(company) {
  const c =
    String(
      company || ""
    ).trim();

  if (!c) {
    return "";
  }

  const n =
    normalize(c);

  if (
    /aramex|ارامكس/.test(n)
  ) {
    return "Aramex";
  }

  if (
    isSaeedi(c)
  ) {
    return "الصاعدي";
  }

  if (
    /^oto$|بوابه الشحن/.test(n)
  ) {
    return "";
  }

  return c;
}


function carrierCodeFromName(company) {
  const n =
    normalize(company);

  if (
    /aramex|ارامكس/.test(n)
  ) {
    return "aramex";
  }

  return "";
}


// ==================================================
// أدوات مساعدة
// ==================================================

async function safeJson(response) {
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
      return String(value);
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
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(
    number
  )
    ? number
    : null;
}


// ==================================================
// ترتيب تاريخ OTO
// ==================================================

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
          b.length -
          a.length
      )[0] || [];

  return list
    .map(item => {
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
            status ||
            ""
          ),

        date:
          String(
            date ||
            ""
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
      obj?.[key] !== undefined &&
      obj?.[key] !== null &&
      obj?.[key] !== ""
    ) {
      return obj[key];
    }
  }

  return "";
}


// ==================================================
// إزالة أرقام حساسة من الوصف
// ==================================================

function redactPII(value) {
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
      /\b\d{9,12}\b/g,
      ""
    );

  return text.trim();
}
