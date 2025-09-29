// /api/assetlinks.js
export default function handler(req, res) {
  // Must be served as JSON
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Your debug SHA-256 fingerprint:
  // DD:3F:80:5E:BC:91:65:8E:7A:D2:9E:0D:1F:A5:C6:53:0C:5A:C2:07:71:C9:F7:13:66:BA:8C:B9:FE:58:5B:55
  // Your applicationId/package_name: yum_yum
  const payload = [
    {
      "relation": ["delegate_permission/common.handle_all_urls"],
      "target": {
        "namespace": "android_app",
        "package_name": "yum_yum",
        "sha256_cert_fingerprints": [
          "DD:3F:80:5E:BC:91:65:8E:7A:D2:9E:0D:1F:A5:C6:53:0C:5A:C2:07:71:C9:F7:13:66:BA:8C:B9:FE:58:5B:55"
        ]
      }
    }
  ];

  res.status(200).send(JSON.stringify(payload, null, 2));
}
