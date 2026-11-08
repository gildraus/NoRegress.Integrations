# Owner setup

One-time steps that only the owner of NoRegress can do, because they need your own Microsoft and GitHub accounts. Everything here is free. Do them in order; each ends with a check.

You need: the Microsoft account you want to own the Marketplace listing, admin access to `gildraus/NoRegress.Integrations` and `gildraus/EvaluateAI` on GitHub, and access to the `noregress.dev` DNS in Cloudflare.

## 1. Azure DevOps organization and project

1. Go to <https://dev.azure.com> and sign in with your Microsoft account.
2. Click **New organization**. Name it, for example `NoRegress`, and pick a region in Europe.
3. In the new organization, click **New project**: name `NoRegress`, visibility **Private**.

Check: `https://dev.azure.com/<organization>/NoRegress/_build` opens the Pipelines page.

## 2. Marketplace publisher

1. Go to <https://marketplace.visualstudio.com/manage/createpublisher> with the same Microsoft account.
2. **ID**: `noregress` (Marketplace ids ignore case, so `NoRegress` is the same id). It is permanent and appears in every link to the extension. If it is taken, pick another ID and tell Claude, because `azure-devops/vss-extension.json` must use it.
3. **Name**: `NoRegress`. Website: `https://noregress.dev`. Fill in the contact email, then **Create**.
4. Start verification now, because it takes a few days: open the publisher's **Details**, find the domain verification for `https://noregress.dev`, and copy the TXT record it shows. In Cloudflare, open the `noregress.dev` zone, **DNS > Records > Add record**, type **TXT**, name and content as shown. Then click **Verify** on the publisher page. A public listing needs a verified publisher; private testing does not.

Check: <https://marketplace.visualstudio.com/manage/publishers/noregress> shows the publisher.

## 3. Marketplace token

1. Open `https://dev.azure.com/<organization>/_usersSettings/tokens` and click **New Token**.
2. Name `marketplace-publish`, **Organization: All accessible organizations** (required, or publishing fails with 401), expiration as long as allowed.
3. **Scopes: Custom defined > Show all scopes > Marketplace: Manage**. Create, and copy the token into your password manager. It is shown once.
4. In GitHub, `gildraus/NoRegress.Integrations` > **Settings > Secrets and variables > Actions > New repository secret**: name `AZURE_DEVOPS_EXT_PAT`, value the token. The release workflow uses it.

Check: the first publish in step 5 succeeds with this token.

## 4. Microsoft-hosted build machines

A new organization cannot run pipelines on Microsoft's machines until it asks for the free tier. The request is free and takes two to three business days.

1. Open <https://aka.ms/azpipelines-parallelism-request>.
2. Fill in your name, email and organization name, choose **Private** projects, and submit.

Check: when the approval email arrives, **Organization settings > Parallel jobs** shows one Microsoft-hosted job for private projects.

## 5. Publish privately and install

Run from the repository root of `NoRegress.Integrations`, with Node 20 or later, in PowerShell:

```powershell
$env:AZURE_DEVOPS_EXT_PAT = Read-Host -MaskInput 'Marketplace token'
node scripts/package-azure.mjs --publish --share-with <organization>
```

1. Check: the command ends with `Completed operation: publish extension`, and the extension appears at <https://marketplace.visualstudio.com/manage/publishers/noregress> as private.
2. In Azure DevOps: **Organization settings > Extensions > Shared**, open **NoRegress** and click **Install**.
3. Check: **Organization settings > Extensions > Installed** lists NoRegress.

## 6. Smoke test pipeline

The published task is smoke-tested from the EvaluateAI repository: `.azure-pipelines/smoke-test.yml` builds and starts the API on the build machine with a random key, then runs `NoRegress@1` against it on one sample case, like the GitHub Action smoke test there. It needs no API key from you and no public API. It needs step 4.

1. **Pipelines > New pipeline > GitHub (YAML)**. Sign in to GitHub and approve the **Azure Pipelines** app for `gildraus/EvaluateAI` when asked.
2. Pick `gildraus/EvaluateAI`, choose **Existing Azure Pipelines YAML file**, branch `master`, path `/.azure-pipelines/smoke-test.yml`, **Continue**, then **Run**.

Check: the run succeeds, the step "Verify task outputs" passes, and the log shows no key.

## 7. Go public (after the publisher is verified)

1. In `azure-devops/vss-extension.json` set `"public": true`, and bump the version there and in `azure-devops/NoRegress/task.json` (for example to 1.0.1). Commit to `main`.
2. Tag and push: `git tag azure-v1.0.1 && git push origin azure-v1.0.1`. The release workflow publishes it.
3. Microsoft reviews public pipeline extensions before they show up in search.

Check: the extension's public page opens at `https://marketplace.visualstudio.com/items?itemName=noregress.noregress`.
