ARG OVERLEAF_VERSION=6.3.1
FROM sharelatex/sharelatex:${OVERLEAF_VERSION}

# The upstream CE image ships scheme-basic. Install the full TeX Live scheme
# so projects do not fail on uncommon packages.
RUN tlmgr install scheme-full && tlmgr path add
