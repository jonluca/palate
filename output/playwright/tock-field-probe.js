async page => {
  async function post(query) {
    return await page.evaluate(async (query) => {
      const response = await fetch("/api/graphql/PatronReservationHistory", {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationName: "PatronReservationHistory",
          variables: { offset: 0, limit: 1, selection: "PAST" },
          query,
        }),
      });
      const json = await response.json().catch(async () => ({ text: await response.text() }));
      return { status: response.status, json };
    }, query);
  }

  const query = `query PatronReservationHistory($offset: Int!, $limit: Int!, $selection: String!) {
  purchases(offset: $offset, limit: $limit, selection: $selection) {
    id
    city
    country
    ticketCount
    ticketDateTime
    business {
      id
      domainName
      name
      address1
      address2
      city
      state
      zipCode
      addressLat
      addressLng
      webUrl
      website
      __typename
    }
    ticketType {
      id
      name
      webUrl
      __typename
    }
    __typename
  }
}`;

  return await post(query);
}
