export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const order = String(req.query.order || "").trim();

    if (!order) {
      return res.status(400).json({
        ok: false,
        error: "رقم الطلب مطلوب"
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecretKey) {
      return res.status(500).json({
        ok: false,
        error: "Supabase configuration missing"
      });
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/orders?reference_id=eq.${encodeURIComponent(order)}&select=*`,
      {
        headers: {
          apikey: supabaseSecretKey,
          Authorization: `Bearer ${supabaseSecretKey}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !Array.isArray(data) || !data.length) {
      return res.status(404).json({
        ok: false,
        error: "الطلب غير موجود"
      });
    }

    const item = data[0];

    const packageCount =
      Number(item.package_count) > 0
        ? Number(item.package_count)
        : 1;

    const labels = [];

    for (let i = 1; i <= packageCount; i++) {
      labels.push({
        package: `${i}/${packageCount}`,
        customerName: item.customer_name || "",
        mobile: item.customer_mobile || "",
        city: item.city || "",
        orderNumber: item.reference_id || item.order_id || "",
        product: [
          item.product_subtitle,
          item.product_option
        ]
          .filter(Boolean)
          .join(" — "),
        shippingStatus: "مدفوع",
        shippingCompany: "الصاعدي"
      });
    }

    return res.status(200).json({
      ok: true,
      orderNumber: item.reference_id || item.order_id,
      packageCount,
      labels,
      shippingInvoice: {
        orderNumber: item.reference_id || item.order_id || "",
        customerName: item.customer_name || "",
        mobile: item.customer_mobile || "",
        city: item.city || "",
        product: [
          item.product_subtitle,
          item.product_option
        ]
          .filter(Boolean)
          .join(" — "),
        packageCount,
        shippingStatus: "مدفوع",
        shippingCompany: "الصاعدي",
        productPriceVisible: false
      }
    });

  } catch (error) {
    console.error("SAEEDI_LABEL_ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "حدث خطأ"
    });
  }
}
