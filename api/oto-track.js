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

    // ==============================
    // سلة أولاً
    // ==============================

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

      // ==============================
      // الصاعدي
      // ==============================

      if (isSaeedi(salla.shippingCompany)) {
        return res.status(200).json(
          buildSaeediResponse(query, salla, stage)
        );
      }

      // ==============================
      // قبل الشحن نعتمد على سلة
      // ==============================

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

      // ==============================
      // بعد الشحن
      // ==============================

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

      // أهم تعديل:
      // ندمج trackShipment + orderHistory
      const history =
        mergeHistories(
          shipment?.history || [],
          buildCarrierHistory(oto)
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

        stage,

        ...uiForStage(stage),

        rawStatus:
          shipment?.otoStatus ||
          shipment?.dcStatus ||
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
          oto?.packageCount ?? null,

        date:
          shipment?.date ||
          oto?.date ||
          salla.date ||
          "",

        history,

        isSaeedi:
          false
      });
    }

    // ==============================
    // الطلبات القديمة من OTO
    // ==============================

    if (
      token &&
      isPossibleOrderNumber(query)
    ) {
      const oto =
        await getOtoOrder(
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
          shipment =
            await trackShipment(
              oto.trackingNumber,
              carrierCode,
              token
            );
        }

        const history =
          mergeHistories(
            shipment?.history || [],
            buildCarrierHistory(oto)
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

          ...uiForStage(stage),

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
            oto.packageCount ?? null,

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

    // ==============================
    // رقم تتبع أرامكس مباشر
    // ==============================

    if (
      token &&
      isPossibleTrackingNumber(query)
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

          ...uiForStage(stage),

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
// التحقق
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
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


// ==================================================
// حالة سلة
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
// حالة OTO
// ==================================================

function classifyOtoStatus(
  status,
  dcStatus
) {
  const s =
    normalize(
      `${status || ""} ${dcStatus || ""}`
    );

  if (
    /delivered|completed|complete|تم التسليم|تم التوصيل/.test(s)
  ) {
    return 4;
  }

  if (
    isCarrierEvent(s)
  ) {
    return 3;
  }

  if (
    /processing|preparing|ready|packed|packing|warehouse|جاري التجهيز/.test(s)
  ) {
    return 2;
  }

  return 1;
}


// ==================================================
// التتبع المباشر
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

  return 3;
}


// ==================================================
// بيانات الواجهة
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
      normalizeId(returnedOrderId) !==
        normalizeId(orderId)
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

    if (!hasRealData) {
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
// ==================================================

function extractTrackingFromUrl(url) {
  try {
    const value =
      String(
        url || ""
      );

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

    if (!items.length) {
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
          number =>
            isPossibleTrackingNumber(
              number
            )
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

    // نخلي تحديثات أرامكس الفعلية
    // ونحذف تحديثات OTO الإدارية فقط
    const carrierHistory =
      normalizedItems
        .filter(item => {
          const combined =
            `${item.status || ""} ${item.dcStatus || ""} ${item.description || ""}`;

          return !isInternalOtoEvent(
            combined
          );
        })
        .slice(
          0,
          30
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
// سجل OTO
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

  return events
    .filter(item => {
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
    });
}


// ==================================================
// دمج السجلين
// ==================================================

function mergeHistories(
  shipmentHistory,
  otoHistory
) {
  const combined = [
    ...(Array.isArray(shipmentHistory)
      ? shipmentHistory
      : []),

    ...(Array.isArray(otoHistory)
      ? otoHistory
      : [])
  ];

  const seen =
    new Set();

  const result =
    [];

  for (
    const item
    of combined
  ) {
    if (!item) {
      continue;
    }

    const status =
      String(
        item.status ||
        item.otoStatus ||
        item.dcStatus ||
        ""
      ).trim();

    const dcStatus =
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
      !status &&
      !dcStatus &&
      !description
    ) {
      continue;
    }

    const combinedText =
      `${status} ${dcStatus} ${description}`;

    if (
      isInternalOtoEvent(
        combinedText
      )
    ) {
      continue;
    }

    // مفتاح لمنع التكرار
    const key =
      [
        normalize(status),
        normalize(dcStatus),
        normalize(description),
        normalizeDateKey(date)
      ].join("|");

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    result.push({
      status,

      dcStatus,

      date,

      description,

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

  result.sort(
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
        Number.isNaN(da) &&
        Number.isNaN(db)
      ) {
        return 0;
      }

      if (
        Number.isNaN(da)
      ) {
        return 1;
      }

      if (
        Number.isNaN(db)
      ) {
        return -1;
      }

      return db - da;
    }
  );

  return result.slice(
    0,
    30
  );
}


function normalizeDateKey(value) {
  const date =
    new Date(
      value
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return String(
      value || ""
    );
  }

  // تقريب للدقيقة لمنع تكرار نفس الحدث
  date.setSeconds(
    0,
    0
  );

  return date.toISOString();
}


// ==================================================
// حالات الشحن
// ==================================================

function isCarrierEvent(value) {
  const s =
    normalize(value);

  return (
    /picked.?up/.test(s) ||
    /pickup/.test(s) ||
    /collected/.test(s) ||

    /received.?by.?carrier/.test(s) ||
    /carrier.?received/.test(s) ||
    /accepted.?by.?carrier/.test(s) ||

    /arrived.?terminal/.test(s) ||
    /departed.?terminal/.test(s) ||

    /arrived.?destination.?terminal/.test(s) ||
    /departed.?destination.?terminal/.test(s) ||

    /arrived.?origin.?terminal/.test(s) ||
    /departed.?origin.?terminal/.test(s) ||

    /arrived.?hub/.test(s) ||
    /departed.?hub/.test(s) ||

    /arrived.?facility/.test(s) ||
    /departed.?facility/.test(s) ||

    /in.?transit/.test(s) ||
    /\btransit\b/.test(s) ||
    /departed/.test(s) ||
    /moving/.test(s) ||
    /forwarded/.test(s) ||

    /with.?courier/.test(s) ||
    /out.?for.?delivery/.test(s) ||

    /delivery.?attempt/.test(s) ||
    /attempted.?delivery/.test(s) ||

    /delivered/.test(s) ||

    /returned/.test(s) ||
    /return.?to.?sender/.test(s) ||

    /delivery.?exception/.test(s) ||
    /undeliverable/.test(s) ||
    /on.?hold/.test(s) ||

    /استلمت.*شركه.*الشحن/.test(s) ||
    /استلام.*شركه.*الشحن/.test(s) ||
    /استلم.*الناقل/.test(s) ||
    /تم.*استلام.*الشحنه/.test(s) ||

    /وصلت.*محطه/.test(s) ||
    /وصلت.*الفرع/.test(s) ||
    /وصلت.*مركز/.test(s) ||

    /غادرت.*المحطه/.test(s) ||
    /غادرت.*الفرع/.test(s) ||
    /غادرت.*المركز/.test(s) ||

    /في.*الطريق/.test(s) ||
    /جاري.*التوصيل/.test(s) ||
    /خرجت.*للتسليم/.test(s) ||

    /محاوله.*تسليم/.test(s) ||
    /تم.*التسليم/.test(s)
  );
}


// ==================================================
// تحديثات OTO الإدارية
// ==================================================

function isInternalOtoEvent(value) {
  const s =
    normalize(value);

  return (
    /تم تحديث/.test(s) ||
    /تم تعديل/.test(s) ||

    /موقع الارسال/.test(s) ||
    /العنوان/.test(s) ||
    /المرسل/.test(s) ||

    /sender/.test(s) ||
    /address/.test(s) ||

    /location updated/.test(s) ||
    /edited/.test(s) ||
    /changed/.test(s) ||

    /order created/.test(s) ||

    /warehouse/.test(s) ||
    /packing/.test(s) ||
    /preparing/.test(s)
  );
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

function normalizeId(value) {
  return String(
    value || ""
  )
    .trim()
    .replace(
      /\s+/g,
      ""
    );
}


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
        found !== undefined
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
    Number(
      value
    );

  return Number.isFinite(
    number
  )
    ? number
    : null;
}


// ==================================================
// سجل OTO
// ==================================================

function normalizeHistory(raw) {
  const arrays =
    [];

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
    })
    .filter(Boolean)
    .slice(
      0,
      60
    );
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


// ==================================================
// حماية البيانات
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
