import http from "k6/http";
import { check } from "k6";

// 50 fake users, running for 30 seconds
export const options = {
  vus: 50,
  duration: "30s",
};

const BASE = "http://localhost:3000";

// setup() runs ONCE before the test: it creates 50 short links
export function setup() {
  const codes = [];
  for (let i = 0; i < 50; i++) {
    const res = http.post(
      `${BASE}/shorten`,
      JSON.stringify({ url: `https://example.com/page/${i}` }),
      { headers: { "Content-Type": "application/json" } }
    );
    codes.push(res.json("short").split("/").pop()); // keep just the code
  }
  return { codes };
}

// default function runs again and again for each fake user
export default function (data) {
  // 80% of clicks go to the first 5 links ("popular links"),
  // 20% go to any link. Real traffic looks like this.
  const hot = Math.random() < 0.8;
  const index = hot
    ? Math.floor(Math.random() * 5)
    : Math.floor(Math.random() * data.codes.length);

  // redirects: 0 means "do NOT follow the redirect".
  // We want to measure OUR server, not example.com.
  const res = http.get(`${BASE}/${data.codes[index]}`, { redirects: 0 });

  check(res, { "status is 302": (r) => r.status === 302 });
}