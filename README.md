# Vigilfield TypeScript SDK

The TypeScript client for the Vigilfield API.

```sh
npm install vigilfield
```

It needs Node.js 20 or later, and is an ES module: use `import`. It has no
dependencies.

## Use your `vf login` sign-in

Sign in once with the command line (`vf login --org <slug>`). A script then
needs no credential of its own:

```ts
import { client } from "vigilfield/login";

const vigilfield = client(); // your default organization, or client("acme")

const tables = await vigilfield.tables.list();
for (const table of tables.data) {
  console.log(table.name);
}
```

The sign-in lasts 24 hours. After that, calls reject with `LoginError` until
you run `vf login` again.

## Use an app's client

For a job that runs without a person, install an app in your organization and
use its client:

```ts
import { VigilfieldClient } from "vigilfield";

const vigilfield = new VigilfieldClient({
  baseUrl: "https://<slug>.vigilfield.com/api/v1",
  clientId: process.env.VF_CLIENT_ID,
  clientSecret: process.env.VF_CLIENT_SECRET,
});
```

The client fetches an access token with the id and secret and renews it by
itself. With `VF_CLIENT_ID` and `VF_CLIENT_SECRET` set you can leave both
options out.

## Reference

A list answers one page: its rows are in `.data`.

The guide is at [vigilfield.com/docs/platform/typescript-sdk](https://vigilfield.com/docs/platform/typescript-sdk),
and every operation is in the API reference at [vigilfield.com/docs](https://vigilfield.com/docs).

This repository is published from Vigilfield's own source. Changes made here
are overwritten by the next release.

Licensed under the Apache License, Version 2.0. See `LICENSE`.
