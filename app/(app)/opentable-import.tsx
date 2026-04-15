import React from "react";
import { ReservationImportBrowserScreen } from "@/components/reservation-import-browser-screen";
import { useImportOpenTableVisitHistory } from "@/hooks/queries";

const OPENTABLE_ACCOUNT_URL = "https://www.opentable.com/user/dining-dashboard";

const OPENTABLE_HISTORY_BRIDGE_SCRIPT = `
(function () {
  if (window.__palateOpenTableBridgeInstalled) {
    if (window.__palateOpenTableReadHistory) {
      window.__palateOpenTableReadHistory();
    }
    true;
    return;
  }

  window.__palateOpenTableBridgeInstalled = true;
  window.__palateOpenTableReadingHistory = false;
  window.__palateOpenTableHistoryPayload = null;

  var OPENTABLE_DASHBOARD_ORIGIN = "https://www.opentable.com";
  var OPENTABLE_DASHBOARD_PAGE_SIZE = 200;
  var OPENTABLE_DETAIL_CONCURRENCY = 4;
  var OPENTABLE_MAX_DASHBOARD_PAGES = 50;
  var MONTH_PATTERN = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

  function post(message) {
    if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
      return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function normalizeText(text) {
    return typeof text === "string" ? text.replace(/\\s+/g, " ").trim() : "";
  }

  function getElementText(element) {
    return normalizeText(element ? element.textContent || "" : "");
  }

  function findByTestId(doc, testId) {
    return doc.querySelector('[data-test="' + testId + '"], [data-testid="' + testId + '"]');
  }

  function asAbsoluteUrl(href) {
    try {
      return new URL(href || "", OPENTABLE_DASHBOARD_ORIGIN).href;
    } catch (error) {
      return null;
    }
  }

  function stripPrivateUrlParams(href) {
    try {
      var url = new URL(href || "", OPENTABLE_DASHBOARD_ORIGIN);
      url.searchParams.delete("token");
      return url.pathname + url.search + url.hash;
    } catch (error) {
      return href || "";
    }
  }

  function getSearchParam(href, name) {
    try {
      return new URL(href || "", OPENTABLE_DASHBOARD_ORIGIN).searchParams.get(name);
    } catch (error) {
      return null;
    }
  }

  function makeAuthError() {
    var error = new Error("AUTH_REQUIRED");
    error.authRequired = true;
    return error;
  }

  function assertDashboardResponse(response, html) {
    if (response.status === 401 || response.status === 403) {
      throw makeAuthError();
    }
    if (!response.ok) {
      throw new Error("DASHBOARD_UNAVAILABLE");
    }
    if (!/Past reservations|Past invites/i.test(html) && /Sign in|Log in/i.test(html)) {
      throw makeAuthError();
    }
  }

  function findSection(doc, headingPattern) {
    var headings = Array.prototype.slice.call(doc.querySelectorAll("h2"));
    for (var i = 0; i < headings.length; i += 1) {
      if (headingPattern.test(getElementText(headings[i]))) {
        return headings[i].parentElement;
      }
    }
    return null;
  }

  function getDashboardPageUrl(pageNumber) {
    return (
      OPENTABLE_DASHBOARD_ORIGIN +
      "/user/dining-dashboard?page=" +
      encodeURIComponent(String(pageNumber)) +
      "&pageSize=" +
      encodeURIComponent(String(OPENTABLE_DASHBOARD_PAGE_SIZE))
    );
  }

  function extractPartyAndDateText(cardLink) {
    var spans = Array.prototype.slice.call(cardLink.querySelectorAll("span"));
    var partyDatePattern = new RegExp("^(\\\\d+)\\\\s*(" + MONTH_PATTERN + ".+)$", "i");
    for (var i = 0; i < spans.length; i += 1) {
      var text = getElementText(spans[i]);
      var match = text.match(partyDatePattern);
      if (match) {
        return {
          partySize: Number(match[1]),
          dateText: normalizeText(match[2])
        };
      }
    }

    return {
      partySize: null,
      dateText: null
    };
  }

  function getCardStatus(cardLink) {
    var spans = Array.prototype.slice.call(cardLink.querySelectorAll("span"));
    for (var i = 0; i < spans.length; i += 1) {
      var text = getElementText(spans[i]);
      if (/reservation/i.test(text)) {
        return text;
      }
    }
    return null;
  }

  function extractDashboardCards(doc, sectionPattern, sourceKind) {
    var section = findSection(doc, sectionPattern);
    if (!section) {
      return [];
    }

    var links = Array.prototype.slice.call(section.querySelectorAll('a[href]'));
    var cards = [];
    for (var i = 0; i < links.length; i += 1) {
      var link = links[i];
      var href = link.getAttribute("href") || "";
      if (href.indexOf("/booking/view") === -1) {
        continue;
      }

      var rawUrl = asAbsoluteUrl(href);
      if (!rawUrl) {
        continue;
      }

      var titleElement = link.querySelector("img[alt]") || link.querySelector("span");
      var restaurantName = normalizeText(
        (titleElement && titleElement.getAttribute && titleElement.getAttribute("alt")) ||
          (titleElement ? titleElement.textContent || "" : "")
      );
      var partyAndDate = extractPartyAndDateText(link);
      var rid = getSearchParam(rawUrl, "rid");
      var confirmationNumber = getSearchParam(rawUrl, "confnumber");
      var invitationId = getSearchParam(rawUrl, "invitationId");
      var reservationId = [sourceKind, rid, confirmationNumber, invitationId].filter(Boolean).join("-");

      cards.push({
        rawUrl: rawUrl,
        sourceUrl: stripPrivateUrlParams(rawUrl),
        sourceKind: sourceKind,
        reservationId: reservationId || stripPrivateUrlParams(rawUrl),
        rid: rid,
        confirmationNumber: confirmationNumber,
        invitationId: invitationId,
        restaurantName: restaurantName,
        status: getCardStatus(link),
        partySize: partyAndDate.partySize,
        dateText: partyAndDate.dateText
      });
    }

    return cards;
  }

  function hasNextReservationPage(doc) {
    var controls = Array.prototype.slice.call(doc.querySelectorAll("button, a"));
    for (var i = 0; i < controls.length; i += 1) {
      var control = controls[i];
      var label = normalizeText(control.getAttribute("aria-label") || control.textContent || "");
      if (!/next page/i.test(label)) {
        continue;
      }
      return !control.disabled && control.getAttribute("aria-disabled") !== "true";
    }
    return false;
  }

  async function fetchDashboardPage(pageNumber) {
    var response = await fetch(getDashboardPageUrl(pageNumber), {
      credentials: "include"
    });
    var html = await response.text();
    assertDashboardResponse(response, html);
    var doc = new DOMParser().parseFromString(html, "text/html");
    return {
      reservations: extractDashboardCards(doc, /^Past reservations$/i, "reservation"),
      invites: extractDashboardCards(doc, /^Past invites$/i, "invite"),
      hasNextPage: hasNextReservationPage(doc)
    };
  }

  async function readDashboardCards() {
    var cards = [];
    var seenKeys = {};

    for (var pageNumber = 1; pageNumber <= OPENTABLE_MAX_DASHBOARD_PAGES; pageNumber += 1) {
      var page = await fetchDashboardPage(pageNumber);
      var pageCards = page.reservations.concat(pageNumber === 1 ? page.invites : []);

      for (var i = 0; i < pageCards.length; i += 1) {
        var card = pageCards[i];
        var key = card.reservationId || card.sourceUrl;
        if (seenKeys[key]) {
          continue;
        }
        seenKeys[key] = true;
        cards.push(card);
      }

      if (page.reservations.length === 0 || page.reservations.length < OPENTABLE_DASHBOARD_PAGE_SIZE || !page.hasNextPage) {
        break;
      }
    }

    return cards;
  }

  function getReservationProfileUrl(doc) {
    var links = Array.prototype.slice.call(doc.querySelectorAll('a[href]'));
    for (var i = 0; i < links.length; i += 1) {
      var href = links[i].getAttribute("href") || "";
      if (/\\/r\\//i.test(href)) {
        return asAbsoluteUrl(href);
      }
    }
    return null;
  }

  function buildDateTimeText(card, detailDateTimeText) {
    var timeMatch = normalizeText(detailDateTimeText).match(/\\b\\d{1,2}(?::\\d{2})?\\s*(?:A\\.?M\\.?|P\\.?M\\.?)\\b/i);
    var dateText = normalizeText(card.dateText);
    if (!dateText) {
      return normalizeText(detailDateTimeText) || null;
    }
    if (!timeMatch) {
      return /\\b\\d{4}\\b/.test(dateText) ? dateText : dateText + ", " + new Date().getFullYear();
    }
    if (!/\\b\\d{4}\\b/.test(dateText)) {
      dateText += ", " + new Date().getFullYear();
    }
    return dateText + " " + timeMatch[0].replace(/\\./g, "");
  }

  function parsePartySize(text, fallback) {
    var match = normalizeText(text).match(/^\\d+/);
    if (match) {
      return Number(match[0]);
    }
    return typeof fallback === "number" && isFinite(fallback) ? fallback : null;
  }

  function buildFallbackReservation(card) {
    return {
      reservationId: card.reservationId,
      rid: card.rid,
      confirmationNumber: card.confirmationNumber,
      invitationId: card.invitationId,
      sourceKind: card.sourceKind,
      sourceUrl: card.sourceUrl,
      restaurantName: card.restaurantName,
      status: card.status,
      partySize: card.partySize,
      dateText: card.dateText,
      dateTime: buildDateTimeText(card, null)
    };
  }

  function extractDetailReservation(card, doc) {
    var restaurantName = getElementText(findByTestId(doc, "restaurant-name")) || card.restaurantName;
    var status = getElementText(findByTestId(doc, "reservation-state")) || card.status;
    var partyText = getElementText(findByTestId(doc, "reservation-party-size"));
    var detailDateTimeText = getElementText(findByTestId(doc, "reservation-date-time"));

    return {
      reservationId: card.reservationId,
      rid: card.rid,
      confirmationNumber: card.confirmationNumber,
      invitationId: card.invitationId,
      sourceKind: card.sourceKind,
      sourceUrl: card.sourceUrl,
      restaurantName: restaurantName,
      status: status,
      partySize: parsePartySize(partyText, card.partySize),
      dateText: card.dateText,
      detailDateTimeText: detailDateTimeText,
      dateTime: buildDateTimeText(card, detailDateTimeText),
      website: getReservationProfileUrl(doc)
    };
  }

  async function fetchDetailReservation(card) {
    try {
      var response = await fetch(card.rawUrl, {
        credentials: "include"
      });
      if (response.status === 401 || response.status === 403) {
        throw makeAuthError();
      }
      if (!response.ok) {
        return buildFallbackReservation(card);
      }

      var html = await response.text();
      var doc = new DOMParser().parseFromString(html, "text/html");
      return extractDetailReservation(card, doc);
    } catch (error) {
      if (error && error.authRequired) {
        throw error;
      }
      return buildFallbackReservation(card);
    }
  }

  async function mapWithConcurrency(items, concurrency, mapper) {
    var results = new Array(items.length);
    var nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        var currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }

    var workers = [];
    var workerCount = Math.min(concurrency, items.length);
    for (var i = 0; i < workerCount; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  function resultCount(payload) {
    return payload && Array.isArray(payload.reservations) ? payload.reservations.length : 0;
  }

  async function readHistory() {
    if (window.__palateOpenTableHistoryPayload) {
      post({
        type: "opentable-history",
        hasSession: true,
        payload: window.__palateOpenTableHistoryPayload,
        count: resultCount(window.__palateOpenTableHistoryPayload),
        error: null
      });
      return;
    }

    if (window.__palateOpenTableReadingHistory) {
      return;
    }

    window.__palateOpenTableReadingHistory = true;
    try {
      if (window.location.hostname !== "www.opentable.com") {
        throw makeAuthError();
      }

      post({
        type: "opentable-history",
        hasSession: true,
        count: 0,
        error: "Reading OpenTable dining dashboard..."
      });

      var cards = await readDashboardCards();
      if (cards.length === 0) {
        post({
          type: "opentable-history",
          hasSession: true,
          count: 0,
          error: "No OpenTable past reservations were found on the dining dashboard."
        });
        return;
      }

      post({
        type: "opentable-history",
        hasSession: true,
        count: 0,
        error: "Reading OpenTable reservation details..."
      });

      var reservations = await mapWithConcurrency(cards, OPENTABLE_DETAIL_CONCURRENCY, fetchDetailReservation);
      var payload = {
        reservations: reservations,
        fetchedCount: cards.length,
        endpoint: "/user/dining-dashboard?page={page}&pageSize=" + OPENTABLE_DASHBOARD_PAGE_SIZE,
        detailEndpoint: "/booking/view"
      };

      window.__palateOpenTableHistoryPayload = payload;
      post({
        type: "opentable-history",
        hasSession: true,
        payload: payload,
        count: resultCount(payload),
        error: null
      });
    } catch (error) {
      if (error && error.authRequired) {
        post({
          type: "opentable-history",
          hasSession: false,
          count: 0,
          error: "Sign in to OpenTable, then open your dining dashboard."
        });
        return;
      }

      post({
        type: "opentable-history",
        hasSession: true,
        count: 0,
        error: "OpenTable history was not available from the dining dashboard."
      });
    } finally {
      window.__palateOpenTableReadingHistory = false;
    }
  }

  window.__palateOpenTableReadHistory = readHistory;
  setInterval(readHistory, 5000);
  setTimeout(readHistory, 300);
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
        "Sign in to OpenTable below. Palate will read your dining dashboard and booking details from the signed-in page."
      }
    />
  );
}
