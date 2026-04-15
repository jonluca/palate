import React from "react";
import { ReservationImportBrowserScreen } from "@/components/reservation-import-browser-screen";
import { useImportOpenTableVisitHistory } from "@/hooks/queries";

const OPENTABLE_ACCOUNT_URL = "https://www.opentable.com/";

const OPENTABLE_HISTORY_BRIDGE_SCRIPT = `
(function () {
  if (window.__palateOpenTableBridgeInstalled) {
    if (window.__palateOpenTableEmit) {
      window.__palateOpenTableEmit();
    }
    true;
    return;
  }

  window.__palateOpenTableBridgeInstalled = true;
  window.__palateOpenTableNetworkCandidates = [];
  window.__palateOpenTableSeenCandidateKeys = {};

  function post(message) {
    if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
      return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function isObject(value) {
    return value && typeof value === "object";
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (typeof value === "number" && isFinite(value)) {
        return String(value);
      }
    }
    return null;
  }

  function getPath(value, path) {
    var current = value;
    for (var i = 0; i < path.length; i += 1) {
      if (!isObject(current)) {
        return undefined;
      }
      current = current[path[i]];
    }
    return current;
  }

  function normalizeText(text) {
    return typeof text === "string" ? text.replace(/\\s+/g, " ").trim() : "";
  }

  function hashString(input) {
    var hash = 0;
    var text = String(input || "");
    for (var i = 0; i < text.length; i += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function getRequestUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input && typeof input === "object") {
      return input.url || input.href || "";
    }
    return "";
  }

  function normalizeUrl(url) {
    try {
      return new URL(String(url || ""), window.location.href).href;
    } catch (error) {
      return String(url || "");
    }
  }

  function isRelevantUrl(url) {
    var normalized = normalizeUrl(url);
    if (!normalized) {
      return false;
    }
    if (/akam|analytics|amplitude|branch|cdn|datadog|doubleclick|facebook|google|googletag|mapbox|newrelic|optimizely|pixel|segment|sentry|static|trustarc/i.test(normalized)) {
      return false;
    }
    return /opentable|\\/api(?:\\/|\\b)|\\/dapi(?:\\/|\\b)|graphql|gql|reservation|booking|dining|history|profile|account|user|visit/i.test(normalized);
  }

  function looksVisible(element) {
    try {
      var rect = element.getBoundingClientRect();
      var style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    } catch (error) {
      return false;
    }
  }

  function extractDateTimeFromText(text) {
    var normalized = normalizeText(text);
    var isoMatch = normalized.match(/\\b\\d{4}-\\d{2}-\\d{2}[T ]\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\b/);
    if (isoMatch) {
      return isoMatch[0];
    }

    var month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
    var dateThenTime = new RegExp("\\\\b" + month + "\\\\s+\\\\d{1,2}(?:,?\\\\s+\\\\d{4})?.{0,40}?(?:\\\\d{1,2}:\\\\d{2}|\\\\d{1,2})(?:\\\\s*[AP]\\\\.?M\\\\.?)\\\\b", "i");
    var timeThenDate = new RegExp("\\\\b(?:\\\\d{1,2}:\\\\d{2}|\\\\d{1,2})(?:\\\\s*[AP]\\\\.?M\\\\.?).{0,40}?" + month + "\\\\s+\\\\d{1,2}(?:,?\\\\s+\\\\d{4})?\\\\b", "i");
    var match = normalized.match(dateThenTime) || normalized.match(timeThenDate);
    return match ? match[0] : null;
  }

  function getRestaurantRecord(record) {
    return (
      record.restaurant ||
      record.restaurantDetails ||
      record.venue ||
      record.venueDetails ||
      record.merchant ||
      record.business ||
      record.ridInfo ||
      record.listing ||
      getPath(record, ["reservation", "restaurant"]) ||
      getPath(record, ["reservation", "venue"]) ||
      getPath(record, ["booking", "restaurant"]) ||
      getPath(record, ["booking", "venue"]) ||
      getPath(record, ["dining", "restaurant"]) ||
      getPath(record, ["restaurantReservation", "restaurant"])
    );
  }

  function getRestaurantName(record) {
    var restaurant = getRestaurantRecord(record);
    return firstString(
      record.restaurantName,
      record.restaurant_name,
      record.venueName,
      record.venue_name,
      record.merchantName,
      record.businessName,
      record.ridName,
      getPath(record, ["reservation", "restaurantName"]),
      getPath(record, ["booking", "restaurantName"]),
      getPath(record, ["dining", "restaurantName"]),
      getPath(record, ["restaurantReservation", "restaurantName"]),
      restaurant && restaurant.name,
      restaurant && restaurant.displayName,
      restaurant && restaurant.title,
      record.name,
      record.title
    );
  }

  function getDateTime(record) {
    var date = firstString(
      record.date,
      record.reservationDate,
      record.bookingDate,
      record.visitDate,
      record.diningDate,
      getPath(record, ["reservation", "date"]),
      getPath(record, ["booking", "date"]),
      getPath(record, ["dining", "date"]),
      getPath(record, ["restaurantReservation", "date"])
    );
    var time = firstString(
      record.time,
      record.reservationTime,
      record.bookingTime,
      record.visitTime,
      record.diningTime,
      getPath(record, ["reservation", "time"]),
      getPath(record, ["booking", "time"]),
      getPath(record, ["dining", "time"]),
      getPath(record, ["restaurantReservation", "time"])
    );

    return firstString(
      record.startTime,
      record.start_time,
      record.startDateTime,
      record.startsAt,
      record.starts_at,
      record.dateTime,
      record.datetime,
      record.dateTimeUtc,
      record.reservationDateTime,
      record.bookingDateTime,
      record.visitDateTime,
      record.diningDateTime,
      record.scheduledAt,
      getPath(record, ["reservation", "startTime"]),
      getPath(record, ["reservation", "startDateTime"]),
      getPath(record, ["reservation", "dateTime"]),
      getPath(record, ["reservation", "dateTimeUtc"]),
      getPath(record, ["booking", "startTime"]),
      getPath(record, ["booking", "startDateTime"]),
      getPath(record, ["booking", "dateTime"]),
      getPath(record, ["dining", "startTime"]),
      getPath(record, ["dining", "dateTime"]),
      getPath(record, ["restaurantReservation", "startTime"]),
      getPath(record, ["restaurantReservation", "dateTime"]),
      date && time ? date + " " + time : null,
      record.text && extractDateTimeFromText(record.text)
    );
  }

  function isCanceledReservation(record) {
    var status = firstString(
      record.status,
      record.state,
      record.reservationStatus,
      record.bookingStatus,
      getPath(record, ["reservation", "status"]),
      getPath(record, ["booking", "status"]),
      getPath(record, ["restaurantReservation", "status"])
    );
    return (
      record.canceled === true ||
      record.cancelled === true ||
      record.isCanceled === true ||
      record.isCancelled === true ||
      !!(status && /cancelled|canceled/i.test(status))
    );
  }

  function looksLikeReservation(record) {
    return isObject(record) && !Array.isArray(record) && !isCanceledReservation(record) && !!getRestaurantName(record) && !!getDateTime(record);
  }

  function keyFor(record) {
    var identifier = firstString(
      record.reservationId,
      record.reservation_id,
      record.bookingId,
      record.booking_id,
      record.confirmationNumber,
      record.confirmationId,
      record.confirmationCode,
      record.reference,
      record.uuid,
      record.id,
      getPath(record, ["reservation", "id"]),
      getPath(record, ["booking", "id"]),
      getPath(record, ["restaurantReservation", "id"])
    );
    return [identifier, getRestaurantName(record), getDateTime(record)].filter(Boolean).join("|");
  }

  function collectCandidates(value, output, seen) {
    if (!isObject(value) || seen.indexOf(value) !== -1) {
      return;
    }
    seen.push(value);

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        collectCandidates(value[i], output, seen);
      }
      return;
    }

    if (looksLikeReservation(value)) {
      output.push(value);
      return;
    }

    Object.keys(value).forEach(function (key) {
      var next = value[key];
      if (isObject(next)) {
        collectCandidates(next, output, seen);
      }
    });
  }

  function rememberNetworkPayload(payload) {
    var found = [];
    collectCandidates(payload, found, []);

    for (var i = 0; i < found.length; i += 1) {
      var key = keyFor(found[i]);
      if (!key) {
        try {
          key = hashString(JSON.stringify(found[i]).slice(0, 2000));
        } catch (error) {
          key = "candidate-" + i;
        }
      }
      if (!window.__palateOpenTableSeenCandidateKeys[key]) {
        window.__palateOpenTableSeenCandidateKeys[key] = true;
        window.__palateOpenTableNetworkCandidates.push(found[i]);
      }
    }

    emit();
  }

  function parsePossibleJson(url, text) {
    if (!isRelevantUrl(url) || typeof text !== "string") {
      return;
    }
    var trimmed = text.trim();
    if (!trimmed || trimmed.length > 20000000 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
      return;
    }
    try {
      rememberNetworkPayload(JSON.parse(trimmed));
    } catch (error) {}
  }

  function clickLoadMoreControls() {
    try {
      var controls = Array.prototype.slice.call(document.querySelectorAll("button, a, [role='button']"));
      for (var i = 0; i < controls.length; i += 1) {
        var control = controls[i];
        var text = normalizeText(control.innerText || control.textContent || control.getAttribute("aria-label") || "");
        if (!looksVisible(control) || control.disabled || control.getAttribute("aria-disabled") === "true") {
          continue;
        }
        if (/^(load|show|view)\\s+(more|older|previous)|more\\s+(reservations|visits|history)|next$/i.test(text)) {
          control.click();
          return true;
        }
      }
    } catch (error) {}
    return false;
  }

  function scrollHistory() {
    try {
      window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.85)));
      Array.prototype.slice
        .call(document.querySelectorAll("main, [role='main'], [data-test*='history'], [data-testid*='history'], [data-test*='reservation'], [data-testid*='reservation'], div"))
        .slice(0, 300)
        .forEach(function (element) {
          if (element.scrollHeight > element.clientHeight + 20) {
            element.scrollTop = Math.min(element.scrollTop + Math.max(500, element.clientHeight), element.scrollHeight);
          }
        });
    } catch (error) {}
  }

  function emit() {
    var count = window.__palateOpenTableNetworkCandidates.length;
    post({
      type: "opentable-history",
      hasSession: count > 0 || !/sign in|log in/i.test(document.body ? document.body.innerText || "" : ""),
      payload: window.__palateOpenTableNetworkCandidates,
      count: count,
      error: count > 0 ? null : "Waiting for OpenTable reservation network data. Sign in, open or refresh your reservations/history page, then let it finish loading."
    });
  }

  var originalFetch = window.fetch;
  if (originalFetch && !window.__palateOpenTableFetchPatched) {
    window.__palateOpenTableFetchPatched = true;
    window.fetch = function () {
      var requestUrl = getRequestUrl(arguments[0]);
      return originalFetch.apply(this, arguments).then(function (response) {
        try {
          var responseUrl = response.url || requestUrl;
          if (isRelevantUrl(responseUrl || requestUrl)) {
            var clone = response.clone();
            var contentType = clone.headers && clone.headers.get ? clone.headers.get("content-type") || "" : "";
            if (/json/i.test(contentType)) {
              clone.json().then(rememberNetworkPayload).catch(function () {});
            } else {
              clone.text().then(function (text) {
                parsePossibleJson(responseUrl || requestUrl, text);
              }).catch(function () {});
            }
          }
        } catch (error) {}
        return response;
      });
    };
  }

  if (window.XMLHttpRequest && !window.__palateOpenTableXhrPatched) {
    window.__palateOpenTableXhrPatched = true;
    var originalXhrOpen = window.XMLHttpRequest.prototype.open;
    var originalXhrSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      this.__palateOpenTableUrl = url;
      return originalXhrOpen.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          var url = this.responseURL || this.__palateOpenTableUrl || "";
          if (!isRelevantUrl(url)) {
            return;
          }
          var contentType = this.getResponseHeader("content-type") || "";
          if (/json/i.test(contentType) && this.response && typeof this.response === "object") {
            rememberNetworkPayload(this.response);
          } else if (/json/i.test(contentType) && this.responseText) {
            rememberNetworkPayload(JSON.parse(this.responseText));
          } else if (this.responseText) {
            parsePossibleJson(url, this.responseText);
          }
        } catch (error) {}
      });
      return originalXhrSend.apply(this, arguments);
    };
  }

  function advanceHistoryCollection() {
    clickLoadMoreControls();
    scrollHistory();
    emit();
  }

  window.__palateOpenTableEmit = emit;
  setInterval(emit, 1000);
  setInterval(advanceHistoryCollection, 2200);
  setTimeout(emit, 300);
  setTimeout(advanceHistoryCollection, 900);
  true;
})();
`;

export default function OpenTableImportScreen() {
  const importMutation = useImportOpenTableVisitHistory();

  return (
    <ReservationImportBrowserScreen
      accountUrl={OPENTABLE_ACCOUNT_URL}
      bridgeScript={OPENTABLE_HISTORY_BRIDGE_SCRIPT}
      bridgeMessageType={"opentable-history"}
      displayName={"OpenTable"}
      brandColor={"#da3743"}
      importMutation={importMutation}
      instructions={
        "Sign in to OpenTable below, then open or refresh your reservations or dining history. Palate will capture reservation history from OpenTable network responses."
      }
    />
  );
}
