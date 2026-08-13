package com.openclassroom.devops.orion.microcrm;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;

@DataJpaTest
class PersonDeletionTest {

    @Autowired
    private TestEntityManager entityManager;

    @Autowired
    private PersonRepository personRepository;

    @Test
    void whenDeletingPersonWithNoOrganization_thenDoesNotThrow() {
        Person jdoe = new Person("John", "Doe", "jdoe@example.net");
        entityManager.persist(jdoe);
        entityManager.flush();

        assertDoesNotThrow(() -> {
            personRepository.delete(jdoe);
            entityManager.flush();
        });
    }

    @Test
    void whenDeletingPersonWithOrganization_thenRemovedFromOrganization() {
        Person jdoe = new Person("John", "Doe", "jdoe@example.net");
        Organization orionInc = new Organization();
        orionInc.setName("Orion Incorporated");
        orionInc.addPerson(jdoe);
        entityManager.persist(orionInc);
        entityManager.flush();
        // Detach and reload: Person.organizations is the mappedBy (inverse) side
        // of the association, only populated by Hibernate when fetched from the
        // database, not by calling Organization.addPerson() in memory.
        entityManager.clear();

        Person reloadedPerson = entityManager.find(Person.class, jdoe.getId());
        personRepository.delete(reloadedPerson);
        entityManager.flush();
        entityManager.clear();

        Organization reloadedOrg = entityManager.find(Organization.class, orionInc.getId());
        assertFalse(reloadedOrg.getPersons().contains(reloadedPerson));
    }
}
