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

    // 1) نبحث أولاً في بيانات سلة الموجودة في Google Sheets
    const sallaOrder = await getSallaOrder(orderId);

    // 2) إذا شركة الشحن هي الصاعدي، ما نحتاج OTO
    if (sallaOrder && isSaeedi(sallaOrder.shippingCompany)) {
      return res.status(200).json({
        ok: true,
        source: "salla",
        orderId,

        status: sallaOrder.status || "",
        dcStatus: "",

        deliveryCompany: "الصاعدي",

        trackingNumber: "",
        trackingUrl: "",
        shipmentId: "",

        date: sallaOrder.date || "",

        packageCount: null,

        specialMessage:
          "تم شحن طلبك بنجاح. تم شحن طلبك وتسليمه لشركة الصاعدي للشحن. مدة التوصيل من يوم إلى 3 أيام عمل. للاستفسار: شركة الصاعدي 0566276686",

        carrierLocation:
          "https://maps.app.goo.gl/NNJ3VgvtCKpaJKkcA",

        history: []
      });
    }

    // 3) نجرب OTO
    const refreshToken = process.env.OTO_REFRESH_TOKEN;

    if (refreshToken) {
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

      if (tokenResponse.ok && accessToken) {
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

        // إذا OTO لقى الطلب
        if (
          statusResponse.ok &&
          statusData?.success !== false
        ) {
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

          const packageCount =
            findNumericField(detailsData, "packageCount") ??
            findNumericField(statusData, "packageCount") ??
            null;

          return res.status(200).json({
            ok: true,
            source: "oto",

            orderId,

            status:
              firstValue(statusData, [
                "status",
                "orderStatus"
              ]) ||
              sallaOrder?.status ||
              "",

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
              ]) ||
              sallaOrder?.shippingCompany ||
              "",

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
              ]) ||
              sallaOrder?.date ||
              "",

            packageCount,

            history: normalizeHistory(historyData)
          });
        }
      }
    }

    // 4) إذا OTO ما لقى الطلب لكن الطلب موجود في سلة
    // هذا مهم للطلبات الجديدة قبل إنشاء البوليصة
    if (sallaOrder) {
      return res.status(200).json({
        ok: true,
        source: "salla",

        orderId,

        status: sallaOrder.status || "",
        dcStatus: "",

        deliveryCompany:
          sallaOrder.shippingCompany || "",

        trackingNumber: "",
        trackingUrl: "",
        shipmentId: "",

        date: sallaOrder.date || "",

        packageCount: null,

        history: []
      });
    }

    // 5) غير موجود لا في سلة ولا OTO
    return res.status(404).json({
      ok: false,
      error: "الطلب غير موجود"
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "حدث خطأ في الاتصال"
    });
  }
}


async function getSallaOrder(orderId) {
  try {
    const url =
      `${SALLA_TRACKING_URL}?order=${encodeURIComponent(orderId)}`;

    const response = await fetch(url, {
      method: "GET",
      redirect: "follow"
    });

    if (!response.ok) {
      return null;
    }

    const data = await safeJson(response);

    if (!data?.ok || !data?.order) {
      return null;
    }

    return {
      orderNumber:
        String(data.order.orderNumber || "").trim(),

      status:
        String(data.order.status || "").trim(),

      date:
        String(data.order.date || "").trim(),

      shippingCompany:
        String(data.order.shippingCompany || "").trim()
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
    value.includes("al-saeedi")
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
