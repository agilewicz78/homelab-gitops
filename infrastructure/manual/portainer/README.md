# Portainer

Portainer CE został zainstalowany ręcznie przez Helm jako komponent platformowy.

URL:

https://portainer.lab.local

Pliki w tym katalogu:
- portainer-cert.yaml - certyfikat TLS dla portainer.lab.local
- portainer-values.yaml - wartości Helm użyte do instalacji/upgrade Portainera

Przykładowy upgrade:

helm upgrade portainer portainer/portainer \
  --namespace portainer \
  -f infrastructure/manual/portainer/portainer-values.yaml
