import { describe, expect, it } from "vitest";
import { compileTrust, trustedAddresses } from "../src/utils/trust-proxy";
import { Request } from "../src/core/request";
import { Pype } from "../src/core/server";
import { start } from "./support/http";

/** A request-shaped object with a socket address and X-Forwarded-For. */
const fakeRequest = (remoteAddress: string, forwardedFor?: string) =>
  ({
    socket: { remoteAddress },
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  }) as unknown as Request;

describe("compileTrust", () => {
  it("handles booleans, hop counts and functions", () => {
    expect(compileTrust(true)("1.2.3.4", 5)).toBe(true);
    expect(compileTrust(false)("127.0.0.1", 0)).toBe(false);
    expect(compileTrust(undefined)("127.0.0.1", 0)).toBe(false);

    const twoHops = compileTrust(2);
    expect(twoHops("1.1.1.1", 0)).toBe(true);
    expect(twoHops("1.1.1.1", 1)).toBe(true);
    expect(twoHops("1.1.1.1", 2)).toBe(false);

    const custom = (address: string) => address === "10.0.0.1";
    expect(compileTrust(custom)).toBe(custom);
  });

  it("expands named ranges", () => {
    const loopback = compileTrust("loopback");
    expect(loopback("127.0.0.1", 0)).toBe(true);
    expect(loopback("127.255.0.9", 0)).toBe(true);
    expect(loopback("::1", 0)).toBe(true);
    expect(loopback("::ffff:127.0.0.1", 0)).toBe(true);
    expect(loopback("8.8.8.8", 0)).toBe(false);

    const local = compileTrust(["linklocal", "uniquelocal"]);
    expect(local("169.254.1.1", 0)).toBe(true);
    expect(local("fe80::1", 0)).toBe(true);
    expect(local("10.1.2.3", 0)).toBe(true);
    expect(local("172.20.0.1", 0)).toBe(true);
    expect(local("192.168.0.10", 0)).toBe(true);
    expect(local("fd00::1", 0)).toBe(true);
    expect(local("172.32.0.1", 0)).toBe(false);
  });

  it("accepts single addresses and CIDRs in comma-separated strings", () => {
    const trust = compileTrust("203.0.113.7, 198.51.100.0/24, 2001:db8::/32");
    expect(trust("203.0.113.7", 0)).toBe(true);
    expect(trust("203.0.113.8", 0)).toBe(false);
    expect(trust("198.51.100.200", 0)).toBe(true);
    expect(trust("2001:db8::abcd", 0)).toBe(true);
    expect(trust("not-an-ip", 0)).toBe(false);
  });

  it("rejects invalid entries", () => {
    expect(() => compileTrust("not-an-ip")).toThrow(TypeError);
  });
});

describe("trustedAddresses", () => {
  it("stops at the first untrusted hop", () => {
    const req = fakeRequest("10.0.0.2", "203.0.113.9, 198.51.100.1, 10.0.0.1");
    expect(trustedAddresses(req, compileTrust("uniquelocal"))).toEqual([
      "10.0.0.2",
      "10.0.0.1",
      "198.51.100.1",
    ]);
  });

  it("returns only the socket address when it isn't trusted", () => {
    const req = fakeRequest("203.0.113.1", "1.1.1.1");
    expect(trustedAddresses(req, compileTrust(false))).toEqual(["203.0.113.1"]);
  });

  it("returns every hop when all are trusted", () => {
    const req = fakeRequest("10.0.0.2", "1.1.1.1, 2.2.2.2");
    expect(trustedAddresses(req, compileTrust(true))).toEqual(["10.0.0.2", "2.2.2.2", "1.1.1.1"]);
  });
});

describe("trust proxy through the app", () => {
  it("uses the hop count setting for req.ip, req.ips, req.protocol and req.hostname", async () => {
    const app = new Pype().set("trust proxy", 1);
    app.get("/", (req: Request, res) => {
      res.json({ ip: req.ip, ips: req.ips, protocol: req.protocol, hostname: req.hostname });
    });

    const api = await start(app);
    const body = await api.json("/", {
      headers: {
        "X-Forwarded-For": "203.0.113.9, 198.51.100.1",
        "X-Forwarded-Proto": "https, http",
        "X-Forwarded-Host": "example.com, proxy.local",
      },
    });
    await api.close();

    expect(body).toEqual({
      ip: "198.51.100.1",
      ips: ["198.51.100.1"],
      protocol: "https",
      hostname: "example.com",
    });
  });

  it("ignores forwarded headers from untrusted peers", async () => {
    const app = new Pype().set("trust proxy", "10.0.0.0/8");
    app.get("/", (req: Request, res) => {
      res.json({ ip: req.ip, ips: req.ips, protocol: req.protocol, secure: req.secure });
    });

    const api = await start(app);
    const body = await api.json("/", {
      headers: { "X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "https" },
    });
    await api.close();

    expect(body.ip).toContain("127.0.0.1");
    expect(body).toMatchObject({ ips: [], protocol: "http", secure: false });
  });
});
