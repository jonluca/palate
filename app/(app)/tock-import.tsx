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

  function post(message) {
    if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
      return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function resultCount(payload) {
    return payload && Array.isArray(payload.result) ? payload.result.length : 0;
  }

  async function readHistory() {
    if (window.__palateTockReadingHistory) {
      return;
    }

    window.__palateTockReadingHistory = true;
    try {
      var response = await fetch("/api/purchase?count=1000", {
        method: "GET",
        credentials: "include",
        headers: {
          "Accept": "application/json"
        }
      });

      if (response.status === 401 || response.status === 403) {
        post({
          type: "tock-history",
          hasSession: false,
          count: 0,
          error: "Sign in to Tock, then open past reservations."
        });
        return;
      }

      if (!response.ok) {
        post({
          type: "tock-history",
          hasSession: true,
          count: 0,
          error: "Tock history was not available from this page."
        });
        return;
      }

      var payload = await response.json();
      post({
        type: "tock-history",
        hasSession: true,
        payload: payload,
        count: resultCount(payload),
        error: null
      });
    } catch (error) {
      post({
        type: "tock-history",
        hasSession: false,
        count: 0,
        error: "Open Tock past reservations after signing in."
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
