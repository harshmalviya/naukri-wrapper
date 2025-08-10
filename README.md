## Naukri API Wrapper (Express)

Express server that proxies selected Naukri endpoints using hardcoded Naukri headers (per provided cURLs). Only variable inputs are accepted from the client. `Cookie` headers are never forwarded.

- Source: `src/server.js`
- Endpoints:
  - POST `/auth/login`
  - GET `/fetch-profile`
  - PUT `/update-profile`

### Requirements

- Node.js >= 18

### Install & Run

```bash
npm install

# optional: set a custom port
export PORT=3000

npm start
# Server listening on http://localhost:${PORT:-3000}
```

### Behavior

- Headers required by Naukri are hardcoded in the server. Do not send browser headers to this wrapper.
- Only send variable inputs:
  - **/auth/login**: `username`, `password`
  - **/fetch-profile**: `Authorization: Bearer <token>`
  - **/update-profile**: `Authorization: Bearer <token>`, `profile` object, `profileId`
- The server never forwards cookies.
- Responses and status codes are proxied as returned by Naukri.

### API Reference

#### POST /auth/login

- Description: Proxies `https://www.naukri.com/central-login-services/v1/login`.
- Body (JSON):
  - `username` (string) – required
  - `password` (string) – required
- No special headers required by this wrapper.

Example cURL (wrapper):

```bash
curl --location 'http://localhost:3000/auth/login' \
--header 'content-type: application/json' \
--data-raw '{"username":"<YOUR_USERNAME>","password":"<YOUR_PASSWORD>"}'
```

#### GET /fetch-profile

- Description: Proxies `https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v2/users/self?expand_level=2`.
- Required header:
  - `Authorization: Bearer <TOKEN>` – required

Example cURL (wrapper):

```bash
curl --location 'http://localhost:3000/fetch-profile' \
--header 'authorization: Bearer <YOUR_BEARER_TOKEN>'
```

#### PUT /update-profile

- Description: Proxies `https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v1/users/self/fullprofiles`.
- Body (JSON):
  - `profile` (object) – required
  - `profileId` (string) – required
- Required header:
  - `Authorization: Bearer <TOKEN>` – required

Example cURL (wrapper):

```bash
curl --location --request PUT 'http://localhost:3000/update-profile' \
--header 'authorization: Bearer <YOUR_BEARER_TOKEN>' \
--header 'content-type: application/json' \
--data '{
  "profile": {
    "resumeHeadline": "Tech enthusiast seeking MERN stack developer roles in product-based companies. Skilled in UI development, writing/tested code, debugging, and adding features based on user feedback. Passionate about building scalable, user-focused web apps."
  },
  "profileId": "<YOUR_PROFILE_ID>"
}'
```

### Notes

- Headers used by Naukri are hardcoded in the server; do not include browser headers when calling this wrapper.
- `Authorization` must be a valid Bearer token for `/fetch-profile` and `/update-profile`.

### File Structure

```
naukri-jwt/
  ├─ src/
  │  └─ server.js
  ├─ package.json
  └─ README.md
```


