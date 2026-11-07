/*
  Tests for the map tool. They check address matching and route-card parsing
  on strings, with no browser. The workflow uses this tool instead of asking
  the model how far a drive is, so a wrong parse here would become a wrong
  fuel cost. Ambiguous cards must throw, not average the alternatives.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pointFromSearchResult,
  parseDrivingRoute,
  addressMatches,
  mapSearchQuery,
  selectStreetAddress,
} from '../headless-maps.ts';
import { researchClients } from '../research.ts';
import { WorkflowError, rank } from '../workflow.ts';
import type { Store } from '../workflow.ts';

test('location extraction requires coordinates from the address result', () => {
  const pin = pointFromSearchResult('41.878', '-87.635');
  assert.deepEqual(pin, { lat: 41.878, lng: -87.635 });
  assert.throws(() => pointFromSearchResult(null, '-87'), WorkflowError);
  assert.throws(() => pointFromSearchResult('not a coordinate', '-87'), WorkflowError);
});
test('invalid coordinates are rejected', () => {
  assert.throws(() => pointFromSearchResult('91', '-87'), WorkflowError);
  assert.throws(() => pointFromSearchResult('41', '-181'), WorkflowError);
});
test('driving card distances and times are parsed together', () => {
  assert.deepEqual(parseDrivingRoute('via Wacker Dr\n12 min\n3.7 miles'), {
    miles: 3.7,
    minutes: 12,
  });
  const metric = parseDrivingRoute('1 hr 5 min\n10 km');
  assert.equal(metric.minutes, 65);
  assert.ok(Math.abs(metric.miles - 6.213711922) < 0.00001);
});
test('alternative routes, missing distances and missing times cannot become estimates', () => {
  for (const text of [
    '12 min',
    '3.7 mi',
    '12 min 3.7 mi or 14 min 4.2 mi',
    '0 min 0 mi',
    'No route',
  ])
    assert.throws(() => parseDrivingRoute(text), WorkflowError);
});
test('address confirmation permits suffix abbreviations but rejects nearby addresses', () => {
  assert.equal(
    addressMatches(
      '233 South Wacker Drive, Chicago, IL',
      'Address: 233 S Wacker Dr, Chicago, IL 60606',
    ),
    true,
  );
  assert.equal(
    addressMatches('233 S Wacker Dr, Chicago, IL', '234 S Wacker Dr, Chicago, IL'),
    false,
  );
  assert.equal(
    addressMatches('233 S Wacker Dr, Chicago, IL', '233 N Wacker Dr, Chicago, IL'),
    false,
  );
  assert.equal(
    addressMatches(
      '233 S Wacker Dr, Chicago, IL 60606',
      'Willis Tower, 233, South Wacker Drive, Chicago, Illinois, 60606, United States',
    ),
    true,
  );
  assert.equal(
    addressMatches('233 S Wacker Dr, Chicago, IL 60606', '233 S Wacker Dr, Chicago, IL 60607'),
    false,
  );
  assert.equal(addressMatches('Chicago, IL', 'Chicago, IL'), false);
  assert.equal(
    addressMatches(
      '1600 Pennsylvania Avenue NW, Washington, DC 20500',
      'White House, 1600, Pennsylvania Avenue Northwest, Ward 2, Washington, District of Columbia, 20500, United States',
    ),
    true,
  );
  assert.equal(
    addressMatches(
      '10 N.W. 5th Street, Oklahoma City, OK 73102',
      '10, Northwest 5th Street, Oklahoma City, Oklahoma County, Oklahoma, 73102, United States',
    ),
    true,
  );
  assert.equal(
    addressMatches(
      '100 NE 1st Ave, Miami, FL 33132',
      '100, Northeast 1st Avenue, Downtown Miami, Miami, Miami-Dade County, Florida, 33132, United States',
    ),
    true,
  );
  assert.equal(
    addressMatches(
      '100 NE 1st Ave, Miami, FL 33132',
      '100, Northeast 1st Avenue, Little Haiti, Miami, Miami-Dade County, Florida, 33137, United States',
    ),
    false,
  );
  assert.equal(
    addressMatches(
      '350 Fifth Avenue, New York, NY 10118',
      'Empire State Building, 350, 5th Avenue, Koreatown, Manhattan, New York County, New York, 10118, United States',
    ),
    true,
  );
  assert.equal(
    addressMatches(
      '350 Fifth Avenue, New York, NY 10118',
      '350, 5th Avenue, North Pelham, Village of Pelham, Town of Pelham, Westchester County, New York, 10803, United States',
    ),
    false,
  );
  assert.equal(
    addressMatches(
      '700 Clark Ave, St. Louis, MO 63102',
      'St. Louis Cardinals Hall of Fame and Museum, 700, Clark Avenue, Downtown, Saint Louis, Missouri, 63102, United States',
    ),
    true,
  );
  assert.equal(
    addressMatches(
      '1 E 161st St, Bronx, NY 10451',
      'Yankee Stadium, 1, East 161st Street, The Bronx, Bronx County, New York, 10451, United States',
    ),
    true,
  );
  assert.equal(
    addressMatches(
      '233 S Wacker Dr Apt 4, Chicago, IL 60606-1234',
      'Willis Tower, 233, South Wacker Drive, Chicago, Illinois, 60606, United States',
    ),
    true,
  );
  assert.equal(
    addressMatches(
      '10 Oak Circle, Madison, WI 53703',
      '10, Oak Circle, Madison, Dane County, Wisconsin, 53703, United States',
    ),
    true,
  );
  assert.equal(
    addressMatches(
      '1600 Pennsylvania Avenue NW, Washington, DC 20500',
      '1600, Pennsylvania Avenue Northwest, Seattle, Washington, 98101, United States',
    ),
    false,
  );
});
test('map search spells ordinals and dotted directions the way the map parser expects', () => {
  assert.equal(
    mapSearchQuery('350 Fifth Avenue, New York, NY 10118'),
    '350 5th Avenue, New York, NY 10118',
  );
  assert.equal(
    mapSearchQuery('10 N.W. 5th Street, Oklahoma City, OK 73102'),
    '10 NW 5th Street, Oklahoma City, OK 73102',
  );
  assert.equal(
    mapSearchQuery('233 S. Wacker Dr., Chicago, IL 60606'),
    '233 S Wacker Dr, Chicago, IL 60606',
  );
  assert.equal(
    mapSearchQuery('233 S Wacker Dr, Chicago, IL 60606'),
    '233 S Wacker Dr, Chicago, IL 60606',
  );
});
test('nearby listings of one US street address count as a single location', () => {
  const text = 'Willis Tower, 233, South Wacker Drive, Chicago, Illinois, 60606, United States';
  const selected = selectStreetAddress('233 S Wacker Dr, Chicago, IL 60606', [
    { text, lat: '41.8787', lng: '-87.6359' },
    { text, lat: '41.8788', lng: '-87.6360' },
  ]);
  assert.equal(selected.lat, '41.8787');
  assert.throws(
    () =>
      selectStreetAddress('233 S Wacker Dr, Chicago, IL 60606', [
        { text, lat: '41.8787', lng: '-87.6359' },
        { text, lat: '40.7128', lng: '-74.0060' },
      ]),
    /one matching US street address/,
  );
  assert.throws(
    () =>
      selectStreetAddress('233 S Wacker Dr, Chicago, IL 60606', [
        {
          text: '233, South Wacker Drive, Chicago, Illinois, 60606',
          lat: '41.8787',
          lng: '-87.6359',
        },
      ]),
    /one matching US street address/,
  );
  const building =
    '20, West 34th Street, Herald Square, Manhattan, New York County, New York, 10118, United States';
  assert.equal(
    selectStreetAddress('20 W 34th St, New York, NY 10001', [
      { text: building, lat: '40.7486', lng: '-73.9853' },
    ]).text,
    building,
  );
  const confirmed =
    'Willis Tower, 233, South Wacker Drive, Chicago, Illinois, 60606, United States';
  const otherZip = 'Other Tower, 233, South Wacker Drive, Chicago, Illinois, 60607, United States';
  assert.equal(
    selectStreetAddress('233 S Wacker Dr, Chicago, IL 60606', [
      { text: otherZip, lat: '41.8788', lng: '-87.636' },
      { text: confirmed, lat: '41.8787', lng: '-87.6359' },
    ]).text,
    confirmed,
  );
});
test('a shelf-only result cannot outrank a known complete pickup cost', () => {
  const base = { round_trip_minutes: 10, fuel_cost: null, total: null } as Store;
  const results = rank(
    [
      { ...base, price: 10, round_trip_miles: null },
      { ...base, price: 18, round_trip_miles: 2 },
    ],
    4,
    25,
  );
  assert.equal(results[0].total, 18.32);
  assert.equal(results[1].total, null);
});
test('missing OpenAI key fails before any research call', () => {
  const old = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => researchClients(), /OPENAI_API_KEY/);
  } finally {
    if (old !== undefined) process.env.OPENAI_API_KEY = old;
  }
});
