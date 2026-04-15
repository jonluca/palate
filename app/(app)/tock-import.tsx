import React from "react";
import { ReservationImportBrowserScreen } from "@/components/reservation-import-browser-screen";
import { useImportTockVisitHistory } from "@/hooks/queries";

const TOCK_ACCOUNT_URL = "https://www.exploretock.com/profile/reservations/past";

const TOCK_HISTORY_BRIDGE_SCRIPT = `
(function () {
  if (window.__palateTockBridgeInstalled) {
    if (window.__palateTockReadHistory) {
      window.__palateTockReadHistory();
    }
    true;
    return;
  }

  window.__palateTockBridgeInstalled = true;
  window.__palateTockReadingHistory = false;

  var TOCK_HISTORY_PAGE_SIZE = 1000;
  var TOCK_HISTORY_QUERY = [
    "query PatronReservationHistory($offset: Int!, $limit: Int!, $selection: String!) {",
    "  purchases(offset: $offset, limit: $limit, selection: $selection) {",
    "    id",
    "    business {",
    "      domainName",
    "      id",
    "      name",
    "      __typename",
    "    }",
    "    cancelledOrRefunded",
    "    city",
    "    country",
    "    ticketCount",
    "    ticketDateTime",
    "    ticketType {",
    "      id",
    "      name",
    "      __typename",
    "    }",
    "    __typename",
    "  }",
    "}"
  ].join("\\n");
  var TOCK_HISTORY_COUNT_QUERY = [
    "query ReservationHistoryCount {",
    "  reservationHistoryCount {",
    "    patron {",
    "      id",
    "      __typename",
    "    }",
    "    cancelledBookingsCount",
    "    pastBookingsCount",
    "    upComingBookingsCount",
    "    __typename",
    "  }",
    "}"
  ].join("\\n");

  function post(message) {
    if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
      return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function resultCount(payload) {
    if (!payload) {
      return 0;
    }
    if (Array.isArray(payload)) {
      return payload.length;
    }
    if (Array.isArray(payload.result)) {
      return payload.result.length;
    }
    if (Array.isArray(payload.purchases)) {
      return payload.purchases.length;
    }
    return 0;
  }

  function getPastBookingsCount(payload) {
    return payload &&
      payload.data &&
      payload.data.reservationHistoryCount &&
      typeof payload.data.reservationHistoryCount.pastBookingsCount === "number"
      ? payload.data.reservationHistoryCount.pastBookingsCount
      : null;
  }

  function getPurchases(payload) {
    return payload && payload.data && Array.isArray(payload.data.purchases) ? payload.data.purchases : [];
  }

  async function postGraphql(operationName, variables, query) {
    var response = await fetch("/api/graphql/" + operationName, {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "*/*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        operationName: operationName,
        variables: variables,
        query: query
      })
    });

    if (response.status === 401 || response.status === 403) {
      var authError = new Error("AUTH_REQUIRED");
      authError.authRequired = true;
      throw authError;
    }

    if (!response.ok) {
      throw new Error("GRAPHQL_UNAVAILABLE");
    }

    var payload = await response.json();
    if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error("GRAPHQL_ERROR");
    }
    return payload;
  }

  async function readHistory() {
    if (window.__palateTockReadingHistory) {
      return;
    }

    window.__palateTockReadingHistory = true;
    try {
      var countPayload = await postGraphql("ReservationHistoryCount", {}, TOCK_HISTORY_COUNT_QUERY);
      var totalCount = getPastBookingsCount(countPayload);
      var purchases = [];
      var offset = 0;

      do {
        var remainingCount = typeof totalCount === "number" ? Math.max(totalCount - offset, 0) : TOCK_HISTORY_PAGE_SIZE;
        var limit = Math.min(TOCK_HISTORY_PAGE_SIZE, remainingCount || TOCK_HISTORY_PAGE_SIZE);
        var pagePayload = await postGraphql(
          "PatronReservationHistory",
          { offset: offset, limit: limit, selection: "PAST" },
          TOCK_HISTORY_QUERY
        );
        var pagePurchases = getPurchases(pagePayload);
        purchases = purchases.concat(pagePurchases);
        offset += pagePurchases.length;

        if (pagePurchases.length === 0 || pagePurchases.length < limit) {
          break;
        }
      } while (typeof totalCount === "number" ? offset < totalCount : offset < 5000);

      var payload = {
        purchases: purchases,
        totalCount: totalCount
      };
      post({
        type: "tock-history",
        hasSession: true,
        payload: payload,
        count: resultCount(payload),
        error: null
      });
    } catch (error) {
      if (error && error.authRequired) {
        post({
          type: "tock-history",
          hasSession: false,
          count: 0,
          error: "Sign in to Tock, then open past reservations."
        });
        return;
      }

      post({
        type: "tock-history",
        hasSession: true,
        count: 0,
        error: "Tock history was not available from this page."
      });
    } finally {
      window.__palateTockReadingHistory = false;
    }
  }

  window.__palateTockReadHistory = readHistory;
  setInterval(readHistory, 2500);
  setTimeout(readHistory, 300);
  true;
})();
`;

export default function TockImportScreen() {
  const importMutation = useImportTockVisitHistory();

  return (
    <ReservationImportBrowserScreen
      accountUrl={TOCK_ACCOUNT_URL}
      bridgeScript={TOCK_HISTORY_BRIDGE_SCRIPT}
      bridgeMessageType={"tock-history"}
      displayName={"Tock"}
      brandColor={"#111827"}
      importMutation={importMutation}
      instructions={"Sign in to Tock below. Palate will read your past reservation history from the signed-in page."}
    />
  );
}
