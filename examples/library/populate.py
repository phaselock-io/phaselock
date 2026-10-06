#!/usr/bin/env python3
"""Populate KurrentDB with some test data for the library demo."""

import datetime
import json
import uuid

import kurrentdbclient as kdbc

CONNSTR = "kurrentdb://admin:changeit@localhost:2113?tls=false"

def ts():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def new_uuid():
    return str(uuid.uuid4())

def event(data):
    return kdbc.NewEvent(type="LibraryEvents", data=json.dumps(data).encode("utf8"))

def uuid_lock(u):
    return kdbc.NewEvents(
        stream_name=f"uuid.{u}",
        events=[kdbc.NewEvent(type="UuidExists", data=b"{}")],
        current_version=kdbc.StreamState.NO_STREAM,
    )

def main():
    client = kdbc.KurrentDBClient(CONNSTR)

    editions = [
        ("978-1-4842-4585-9", "Versioning in an Event Sourced System"),
        ("978-1-4842-2553-0", "Implementing Domain-Driven Design"),
        ("978-1-09-812345-6", "Building Local-First Software"),
        ("978-0-13-709431-2", "Designing Offline-First Web Apps with Sync Engines"),
    ]

    patrons = [
        ("patron-1", "Alice", True),
        ("patron-2", "Bob", False),
    ]

    # add editions and books
    book_events = []
    new_eventses = []
    for isbn, title in editions:
        book_events.append(event({"type": "add-edition", "isbn": isbn, "title": title, "timestamp": ts()}))
        # add 2 copies of each, one restricted and one not
        for restricted in [False, True]:
            book_id = new_uuid()
            book_events.append(event({"type": "add-book", "id": book_id, "isbn": isbn, "restricted": restricted, "timestamp": ts()}))
            new_eventses.append(uuid_lock(book_id))

    new_eventses.append(kdbc.NewEvents(
        stream_name="books",
        events=book_events,
        current_version=kdbc.StreamState.ANY,
    ))

    # add patrons (each on their own stream)
    for patron_id, name, researcher in patrons:
        new_eventses.append(kdbc.NewEvents(
            stream_name=f"patron:{patron_id}",
            events=[event({"type": "add-patron", "id": patron_id, "name": name, "researcher": researcher, "timestamp": ts()})],
            current_version=kdbc.StreamState.ANY,
        ))

    client.multi_append_to_stream(new_eventses)
    print(f"Created {len(editions)} editions, {len(editions) * 2} books, {len(patrons)} patrons")

if __name__ == "__main__":
    main()
