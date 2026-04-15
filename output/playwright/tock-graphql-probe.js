async page => {
  const historyQuery = `query PatronReservationHistory($offset: Int!, $limit: Int!, $selection: String!) {
  purchases(offset: $offset, limit: $limit, selection: $selection) {
    id
    business {
      domainName
      id
      name
      profileImages {
        altText
        backingUrl
        dominantColor
        id
        imageUrl
        __typename
      }
      __typename
    }
    cancelledOrRefunded
    city
    country
    dinerPatron {
      email
      firstName
      lastName
      id
      __typename
    }
    eligibleForFeedback
    visitFiveStarRating
    firstTransferredTo {
      id
      __typename
    }
    ownerPatron {
      email
      firstName
      lastName
      id
      __typename
    }
    ticketCount
    ticketDateTime
    ticketType {
      deliveryServiceProvider
      descriptiveVariety
      id
      name
      reserveShippingTime
      singleUnitQuantity
      variety
      __typename
    }
    __typename
  }
}`;

  const countQuery = `query ReservationHistoryCount {
  reservationHistoryCount {
    patron {
      id
      __typename
    }
    cancelledBookingsCount
    pastBookingsCount
    upComingBookingsCount
    __typename
  }
}`;

  async function post(operationName, variables, query) {
    return await page.evaluate(
      async ({ operationName, variables, query }) => {
        const response = await fetch(`/api/graphql/${operationName}`, {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "*/*",
            "content-type": "application/json",
          },
          body: JSON.stringify({ operationName, variables, query }),
        });
        const text = await response.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        return { status: response.status, url: response.url, text: text.slice(0, 500), json };
      },
      { operationName, variables, query },
    );
  }

  const count = await post("ReservationHistoryCount", {}, countQuery);
  const firstPast = await post("PatronReservationHistory", { offset: 0, limit: 30, selection: "PAST" }, historyQuery);
  const secondPast = await post("PatronReservationHistory", { offset: 30, limit: 30, selection: "PAST" }, historyQuery);
  const bigPast = await post("PatronReservationHistory", { offset: 0, limit: 1000, selection: "PAST" }, historyQuery);
  const upcoming = await post("PatronReservationHistory", { offset: 0, limit: 30, selection: "UPCOMING" }, historyQuery);

  function summarize(result) {
    const purchases = result.json?.data?.purchases;
    return {
      status: result.status,
      url: result.url,
      errors: result.json?.errors ?? null,
      count: Array.isArray(purchases) ? purchases.length : null,
      total: result.json?.data?.reservationHistoryCount ?? null,
      first: Array.isArray(purchases)
        ? purchases.slice(0, 5).map((purchase) => ({
            id: purchase.id,
            restaurantName: purchase.business?.name ?? null,
            ticketDateTime: purchase.ticketDateTime ?? null,
            ticketCount: purchase.ticketCount ?? null,
          }))
        : null,
      text: result.json ? undefined : result.text,
    };
  }

  return {
    count: summarize(count),
    firstPast: summarize(firstPast),
    secondPast: summarize(secondPast),
    bigPast: summarize(bigPast),
    upcoming: summarize(upcoming),
  };
}
