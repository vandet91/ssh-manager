FROM python:3.12-alpine

# iputils for ping (used by registration script's connectivity test)
RUN apk add --no-cache iputils

WORKDIR /app
COPY snmp_sim.py .

ENV SNMP_COMMUNITY=public
ENV BASE_PORT=1161

EXPOSE 1161/udp 1162/udp 1163/udp 1164/udp 1165/udp 1166/udp 1167/udp

CMD ["python", "snmp_sim.py"]
