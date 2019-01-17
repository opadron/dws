FROM node

RUN RELEASES='https://github.com/Yelp/dumb-init/releases/download' \
 && wget -O /usr/local/bin/dumb-init "$RELEASES/v1.2.2/dumb-init_1.2.2_amd64" \
 && chmod +x /usr/local/bin/dumb-init

RUN mkdir /app
WORKDIR /app
COPY index.js package.json package-lock.json ./
RUN npm install
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dumb-init", "--", "node", "index.js"]
CMD []
