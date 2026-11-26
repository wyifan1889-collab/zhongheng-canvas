import { describe, expect, test } from "bun:test";
import { readPaymentConfig } from "./payment-config";

const enabled = { SAAS_PAYMENTS_ENABLED: "true", SAAS_PAYMENTS_TIMEOUT_MS: "1500", SAAS_PAYMENTS_JSON_MAX_BYTES: "4096",
    SAAS_PAYMENTS_LINK_ORIGINS: '["https://pay.example"]' };

describe("explicit payment runtime configuration", () => {
    test("is closed by default and does not require payment values to save administrator drafts", () => {
        expect(readPaymentConfig({})).toEqual({ enabled: false });
        expect(readPaymentConfig({ SAAS_PAYMENTS_ENABLED: "false", SAAS_PAYMENTS_TIMEOUT_MS: "bad" })).toEqual({ enabled: false });
        for (const value of ["", "TRUE", "1", " true "]) expect(() => readPaymentConfig({ SAAS_PAYMENTS_ENABLED: value })).toThrow();
    });
    test("requires every explicit safe value when enabled without inventing limits", () => {
        expect(readPaymentConfig(enabled)).toEqual({ enabled: true, timeoutMs: 1500, maxResponseBytes: 4096, paymentLinkOrigins: ["https://pay.example"] });
        for (const name of ["SAAS_PAYMENTS_TIMEOUT_MS", "SAAS_PAYMENTS_JSON_MAX_BYTES", "SAAS_PAYMENTS_LINK_ORIGINS"]) {
            expect(() => readPaymentConfig({ ...enabled, [name]: undefined })).toThrow(name);
        }
        for (const value of ["", "0", "-1", "1.1", "1e3", "01", " 1", "9007199254740992"]) {
            expect(() => readPaymentConfig({ ...enabled, SAAS_PAYMENTS_TIMEOUT_MS: value })).toThrow();
            expect(() => readPaymentConfig({ ...enabled, SAAS_PAYMENTS_JSON_MAX_BYTES: value })).toThrow();
        }
        expect(() => readPaymentConfig({ ...enabled, SAAS_PAYMENTS_TIMEOUT_MS: "2147483648" })).toThrow();
        expect(readPaymentConfig({ ...enabled, SAAS_PAYMENTS_TIMEOUT_MS: "2147483647", SAAS_PAYMENTS_JSON_MAX_BYTES: "9007199254740991" }))
            .toMatchObject({ enabled: true, timeoutMs: 2147483647, maxResponseBytes: 9007199254740991 });
    });
    test("accepts only explicit unique HTTPS origins and keeps an explicitly empty deny-all list", () => {
        for (const raw of ['null', '{}', '[1]', '["http://pay.example"]', '["https://pay.example/path"]', '["https://user@pay.example"]',
            '["https://pay.example/"]', '["https://pay.example?"]', '["https://pay.example#"]', '["https://PAY.example"]',
            '["https://pay.example:443"]', '["https://pay.example","https://pay.example"]', '["https://pay.example",]',
            '[/*comment*/"https://pay.example"]', '["https://pay.example\\n"]']) {
            expect(() => readPaymentConfig({ ...enabled, SAAS_PAYMENTS_LINK_ORIGINS: raw })).toThrow("SAAS_PAYMENTS_LINK_ORIGINS");
        }
        expect(readPaymentConfig({ ...enabled, SAAS_PAYMENTS_LINK_ORIGINS: "[]" })).toMatchObject({ enabled: true, paymentLinkOrigins: [] });
    });
});
