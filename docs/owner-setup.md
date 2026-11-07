# Owner setup

One-time steps that only the owner of NoRegress can do, because they need your own Microsoft and GitHub accounts. Everything here is free. Do them in order; each ends with a check.

You need: the Microsoft account you want to own the Marketplace listing, admin access to `gildraus/NoRegress.Integrations` on GitHub, access to the `noregress.dev` DNS in Cloudflare, and the demo PC.

## 1. Azure DevOps organization and project

1. Go to <https://dev.azure.com> and sign in with your Microsoft account.
2. Click **New organization**. Name it, for example `noregress`, and pick a region in Europe.
3. In the new organization, click **New project**: name `NoRegress`, visibility **Private**.

Check: `https://dev.azure.com/<organization>/NoRegress/_build` opens the Pipelines page.

## 2. Marketplace publisher

1. Go to <https://marketplace.visualstudio.com/manage/createpublisher> with the same Microsoft account.
2. **ID**: `noregress`. It is permanent and appears in every link to the extension. If `noregress` is taken, pick another ID and tell Claude, because `azure-devops/vss-extension.json` must use it.
3. **Name**: `NoRegress`. Website: `https://noregress.dev`. Fill in the contact email, then **Create**.
4. Start verification now, because it takes a few days: open the publisher's **Details**, find the domain verification for `https://noregress.dev`, and copy the TXT record it shows. In Cloudflare, open the `noregress.dev` zone, **DNS > Records > Add record**, type **TXT**, name and content as shown. Then click **Verify** on the publisher page. A public listing needs a verified publisher; private testing does not.

Check: <https://marketplace.visualstudio.com/manage/publishers/noregress> shows the publisher.

## 3. Marketplace token

1. Open `https://dev.azure.com/<organization>/_usersSettings/tokens` and click **New Token**.
2. Name `marketplace-publish`, **Organization: All accessible organizations** (required, or publishing fails with 401), expiration as long as allowed.
3. **Scopes: Custom defined > Show all scopes > Marketplace: Manage**. Create, and copy the token into your password manager. It is shown once.
4. In GitHub, `gildraus/NoRegress.Integrations` > **Settings > Secrets and variables > Actions > New repository secret**: name `AZURE_DEVOPS_EXT_PAT`, value the token. The release workflow uses it.

Check: the first publish in step 6 succeeds with this token.

## 4. Build agent on the demo PC

Microsoft's own build machines need a free-tier request that takes days. A self-hosted agent on the demo PC needs none, and one is free with unlimited minutes.

1. Create a second token on the same page as step 3: name `agent`, organization your new one, scope **Agent Pools: Read & manage**. Copy it.
2. In Azure DevOps: **Organization settings > Agent pools > Default > New agent > Windows**. Download the zip.
3. On the demo PC, in PowerShell:

   ```powershell
   mkdir C:\agents\noregress; cd C:\agents\noregress
   Expand-Archive "$HOME\Downloads\vsts-agent-win-x64-*.zip" .
   .\config.cmd
   ```

   Answer: server URL `https://dev.azure.com/<organization>`, authentication **PAT** (paste the `agent` token), pool **Default**, agent name `demo-pc`, work folder default, **run as a service: Y**.

Check: **Organization settings > Agent pools > Default > Agents** shows `demo-pc` as **Online**.

## 5. API key for the live tests

The live tests call `https://api.noregress.dev` like a customer would, so they need a key the API accepts. Use the demo PC's key: `ServiceKeys__0` in the `.env` file in the EvaluateAI repository root (or the key `start-local.ps1` printed on its first run).

1. GitHub: `gildraus/NoRegress.Integrations` > **Settings > Secrets and variables > Actions > New repository secret**: name `NOREGRESS_API_KEY`, value the key.
2. Azure DevOps: create the pipeline first (step 6.4), then **Edit > Variables > New variable**: name `NoRegressApiKey`, value the key, tick **Keep this value secret**.

Check, from any machine:

```sh
curl -s -X POST https://api.noregress.dev/evaluate \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"cases":[{"id":"check","actualOutput":"ok","deterministicRules":[{"id":"short","type":"maxLength","value":10}]}]}'
```

The last line is a `summary` with `"outcome":"passed"`.

## 6. Publish privately and install

Run from the repository root of `NoRegress.Integrations`, with Node 20 or later:

```sh
node scripts/package-azure.mjs --publish --token <marketplace-publish token> --share-with <organization>
```

1. Check: the command ends with `Completed operation: publish extension`, and the extension appears at <https://marketplace.visualstudio.com/manage/publishers/noregress> as private.
2. In Azure DevOps: **Organization settings > Extensions > Shared**, open **NoRegress** and click **Install**.
3. Check: **Organization settings > Extensions > Installed** lists NoRegress.
4. Create the test pipeline: **Pipelines > New pipeline > GitHub**, authorize, pick `gildraus/NoRegress.Integrations`, **Existing Azure Pipelines YAML file**, path `/azure-pipelines.yml`, then **Save** (not Run). Add the `NoRegressApiKey` variable from step 5.
5. Make sure `start-local.ps1` is running on the demo PC, then **Run pipeline**.

Check: the first two NoRegress steps pass, the regressed step fails, the last check passes, and the run's **Tests** tab lists every case.

## 7. Go public (after the publisher is verified)

1. In `azure-devops/vss-extension.json` set `"public": true`, and bump the version there and in `azure-devops/NoRegress/task.json` (for example to 1.0.1). Commit to `main`.
2. Tag and push: `git tag azure-v1.0.1 && git push origin azure-v1.0.1`. The release workflow publishes it.
3. Microsoft reviews public pipeline extensions before they show up in search.

Check: the extension's public page opens at `https://marketplace.visualstudio.com/items?itemName=noregress.noregress`.
