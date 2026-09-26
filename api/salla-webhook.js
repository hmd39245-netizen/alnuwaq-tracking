export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  console.log("SALLA_WEBHOOK:", JSON.stringify(req.body));

  return res.status(200).json({ ok: true });
}
