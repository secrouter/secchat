# SSO: Mattermost ↔ SecSSO

Mattermost **Team Edition** does OAuth SSO through its **GitLab** connector (SAML/OIDC are
Enterprise-only). SecSSO (Authentik) can present GitLab-compatible OAuth endpoints, so the
suite gets single sign-on on Community Edition.

## 1. Create the provider in SecSSO

In Authentik, create an OAuth2 provider + application for SecChat with these redirect URIs:

```
<MM_SITE_URL>/signup/gitlab/complete
<MM_SITE_URL>/login/gitlab/complete
```

Note the client id (`secchat`) and client secret. Authentik documents the exact
"Mattermost" integration (the GitLab-compatible authorize/token/userinfo endpoints); follow
its current guide for your pinned Authentik version — the endpoint paths are what go in the
`MM_GITLAB_*` variables.

## 2. Point Mattermost at it

Set in `.env` (or System Console → Authentication → GitLab):

```
MM_GITLAB_ENABLE=true
MM_GITLAB_ID=secchat
MM_GITLAB_SECRET=<from SecSSO>
MM_GITLAB_AUTH_ENDPOINT=<SecSSO authorize URL>
MM_GITLAB_TOKEN_ENDPOINT=<SecSSO token URL>
MM_GITLAB_USER_ENDPOINT=<SecSSO userinfo/user URL>
```

Restart: `./bootstrap/secchat.sh down && ./bootstrap/secchat.sh up`. A **"GitLab"** button now
appears on the Mattermost login page; it authenticates against SecSSO.

## Using your own IdP

SecChat doesn't require SecSSO. Point the GitLab connector at any GitLab-compatible OAuth
provider, or — on Mattermost Enterprise — use the native SAML/OIDC connectors against your
existing IdP. In the SecDeploy suite this is the `--without secsso` path.

## Match groups to policy

If you also gate models through SecRouter, keep Mattermost/SecSSO group names aligned with
SecRouter's policy groups so a user's access is consistent from chat to gateway.
