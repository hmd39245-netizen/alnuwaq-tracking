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

    const orderId =
      String(
        order.id ||
        data.id ||
        ""
      ).trim();

    const referenceId =
      String(
        order.reference_id ||
        order.referenceId ||
        ""
      ).trim();

    const status =
      String(
        order.status?.name ||
        data.status ||
        ""
      ).trim();

    const customer =
      order.customer || {};

    const shipping =
      order.shipping || {};

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        error: "Missing order id"
      });
    }

    const row = {
      order_id: orderId,
      reference_id: referenceId || null,
      status: status || null,

      customer_name:
        String(customer.name || "").trim() || null,

      customer_mobile:
        String(customer.mobile || "").trim() || null,

      city:
        String(customer.city || "").trim() || null,

      tracking_number:
        String(
          shipping.tracking_number ||
          shipping.trackingNumber ||
          ""
        ).trim() || null,

      shipping_company:
        String(
          shipping.company ||
          shipping.company_name ||
          shipping.companyName ||
          ""
        ).trim() || null,

      updated_at:
        new Date().toISOString()
    };

    const supabaseUrl =
      process.env.SUPABASE_URL;

    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecretKey) {
      console.error("Missing Supabase environment variables");

      return res.status(500).json({
        ok: false,
        error: "Supabase configuration missing"
      });
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/orders?on_conflict=order_id`,
      {
        method: "POST",

        headers: {
          apikey: supabaseSecretKey,
          Authorization: `Bearer ${supabaseSecretKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation"
        },

        body: JSON.stringify(row)
      }
    );

    const text = await response.text();

    if (!response.ok) {
      console.error(
        "SUPABASE_ERROR:",
        response.status,
        text
      );

      return res.status(500).json({
        ok: false,
        error: "Failed to save order"
      });
    }

    console.log(
      "ORDER_SAVED:",
      orderId,
      status
    );

    return res.status(200).json({
      ok: true,
      saved: true,
      event,
      orderId,
      status
    });

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
