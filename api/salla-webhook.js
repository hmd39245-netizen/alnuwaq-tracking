export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const body = req.body || {};
    const event = String(body.event || "").trim();
    const data = body.data || {};

    console.log("SALLA_WEBHOOK:", JSON.stringify(body));

    if (
      event !== "order.created" &&
      event !== "order.status.updated"
    ) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        event
      });
    }

    const order =
      event === "order.created"
        ? data
        : data.order || {};

    const orderId = String(
      order.id || data.id || ""
    ).trim();

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        error: "Missing order id"
      });
    }

    const referenceId = String(
      order.reference_id ||
      order.referenceId ||
      ""
    ).trim();

    const status = String(
      order.status?.name ||
      data.status ||
      ""
    ).trim();

    const customer = order.customer || {};
    const shipping = order.shipping || {};

    const supabaseUrl =
      process.env.SUPABASE_URL;

    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecretKey) {
      console.error(
        "Missing Supabase environment variables"
      );

      return res.status(500).json({
        ok: false,
        error: "Supabase configuration missing"
      });
    }

    // =========================================
    // إنشاء طلب جديد
    // =========================================
    if (event === "order.created") {
      const items =
        Array.isArray(order.items)
          ? order.items
          : [];

      const firstItem =
        items[0] || {};

      // الاسم الفرعي مثل: ابيض
      const productSubtitle =
        String(
          firstItem?.product
            ?.promotion
            ?.sub_title || ""
        ).trim();

      // الخيار مثل: بني مموج
      const productOption =
        String(
          firstItem?.options?.[0]
            ?.value?.name || ""
        ).trim();

      const quantity =
        Number(firstItem.quantity) || 1;

      // =========================================
      // حساب عدد قطع الشحن
      // أليكسا = 3 قطع لكل طاولة
      // =========================================
      let packageCount = 0;

      for (const item of items) {
        const itemName =
          normalizeArabic(
            item?.product?.name ||
            item?.name ||
            ""
          );

        const itemQuantity =
          Number(item?.quantity) || 1;

        const isAlexa =
          itemName.includes("اليكسا");

        if (isAlexa) {
          packageCount +=
            3 * itemQuantity;
        }
      }

      // إذا لم توجد طاولة أليكسا
      // نخليه قطعة واحدة افتراضيًا
      if (packageCount === 0) {
        packageCount = 1;
      }

      const row = {
        order_id: orderId,

        reference_id:
          referenceId || null,

        status:
          status || null,

        customer_name:
          String(
            customer.full_name ||
            customer.name ||
            ""
          ).trim() || null,

        customer_mobile:
          String(
            customer.mobile || ""
          ).trim() || null,

        city:
          String(
            customer.city || ""
          ).trim() || null,

        tracking_number:
          String(
            shipping?.tracking_number ||
            shipping?.trackingNumber ||
            ""
          ).trim() || null,

        shipping_company:
          String(
            shipping?.company ||
            shipping?.company_name ||
            shipping?.companyName ||
            ""
          ).trim() || null,

        product_subtitle:
          productSubtitle || null,

        product_option:
          productOption || null,

        quantity,

        package_count:
          packageCount,

        updated_at:
          new Date().toISOString()
      };

      const response = await fetch(
        `${supabaseUrl}/rest/v1/orders?on_conflict=order_id`,
        {
          method: "POST",

          headers: {
            apikey:
              supabaseSecretKey,

            Authorization:
              `Bearer ${supabaseSecretKey}`,

            "Content-Type":
              "application/json",

            Prefer:
              "resolution=merge-duplicates,return=representation"
          },

          body:
            JSON.stringify(row)
        }
      );

      const text =
        await response.text();

      if (!response.ok) {
        console.error(
          "SUPABASE_ERROR:",
          response.status,
          text
        );

        return res.status(500).json({
          ok: false,
          error:
            "Failed to save order"
        });
      }

      console.log(
        "ORDER_SAVED:",
        orderId,
        productSubtitle,
        productOption,
        packageCount
      );

      return res.status(200).json({
        ok: true,
        saved: true,
        event,
        orderId,
        status,
        productSubtitle,
        productOption,
        quantity,
        packageCount
      });
    }

    // =========================================
    // تحديث حالة الطلب
    // لا نمسح بيانات المنتج القديمة
    // =========================================
    if (event === "order.status.updated") {
      const updateRow = {
        status:
          status || null,

        reference_id:
          referenceId || null,

        customer_name:
          String(
            customer.full_name ||
            customer.name ||
            ""
          ).trim() || null,

        customer_mobile:
          String(
            customer.mobile || ""
          ).trim() || null,

        city:
          String(
            customer.city || ""
          ).trim() || null,

        updated_at:
          new Date().toISOString()
      };

      const response = await fetch(
        `${supabaseUrl}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`,
        {
          method: "PATCH",

          headers: {
            apikey:
              supabaseSecretKey,

            Authorization:
              `Bearer ${supabaseSecretKey}`,

            "Content-Type":
              "application/json",

            Prefer:
              "return=representation"
          },

          body:
            JSON.stringify(updateRow)
        }
      );

      const text =
        await response.text();

      if (!response.ok) {
        console.error(
          "SUPABASE_UPDATE_ERROR:",
          response.status,
          text
        );

        return res.status(500).json({
          ok: false,
          error:
            "Failed to update order"
        });
      }

      console.log(
        "ORDER_UPDATED:",
        orderId,
        status
      );

      return res.status(200).json({
        ok: true,
        updated: true,
        event,
        orderId,
        status
      });
    }

  } catch (error) {
    console.error(
      "SALLA_WEBHOOK_ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "Internal server error"
    });
  }
}


// =========================================
// تنظيف العربي
// أليكسا / اليكسا تعتبر نفس الكلمة
// =========================================
function normalizeArabic(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}
