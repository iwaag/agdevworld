# The agdev origin's web server: routing only (nginx.conf). Home (/wfe/) is
# the workflow editor service on the host; /hangout/ is aghangout's own
# release, mounted from the host (compose.yaml). Nothing is built here.
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80 8093
