# Upstream Baseline

- Official repository: `https://github.com/overleaf/overleaf`
- Official compose source commit:
  `e039ad26c5bf5422eb57b89fc7e57c75055e631d`
- Community Edition release: `6.3.1`
- Community Edition image ID from official release notes:
  `0c659950e27f`
- Compose paths adapted for this host:
  - data volumes moved to `/home_ext/quyanyi/overleaf-data`
  - web binding changed from `80` to `127.0.0.1:51007`
  - Server Pro sandbox options removed for Community Edition

The upstream Git repository has no modern release tags for the current
monorepo. The deployable release is therefore locked by the container tag
`sharelatex/sharelatex:6.3.1`, not by `main` or `latest`.
