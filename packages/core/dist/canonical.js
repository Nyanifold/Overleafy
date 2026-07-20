import { createHash } from "node:crypto";
function normalize(value) {
    if (Array.isArray(value)) {
        return value.map(normalize);
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, normalize(entry)]));
    }
    return value;
}
export function canonicalJson(value) {
    return JSON.stringify(normalize(value));
}
export function sha256(value) {
    return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
//# sourceMappingURL=canonical.js.map